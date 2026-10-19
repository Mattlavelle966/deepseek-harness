/** Shared client services and presentation state owned by one terminal frontend. */
import { t } from './copy.ts'

import { Context } from '@deepseek-ai/cordis'
import { installConnection, type ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import * as registry from '@deepseek-ai/dsh-typert-registry/client'
import * as gateway from '@deepseek-ai/dsh-api-gateway/client'
import * as remotes from '@deepseek-ai/dsh-api-remotes/client'
import * as uploads from '@deepseek-ai/dsh-client-file-upload/client'
import * as sessions from '@deepseek-ai/dsh-api-session-controller/client'
import * as workspaces from '@deepseek-ai/dsh-api-workspace-controller/client'
import * as terminals from '@deepseek-ai/dsh-api-terminal-controller/client'
import {
  UiConversation,
  resolveSubmitMode,
  DEFAULT_BUSY_ENTER_BEHAVIOR,
  type BusyEnterBehavior,
} from '@deepseek-ai/dsh-client-ui-conversation/client/headless'
import { registerConversationNodes } from '@deepseek-ai/dsh-client-ui-chat/client/headless'
import type { ConversationBinding } from '@deepseek-ai/dsh-client-ui-conversation/client/headless'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client/headless'
import type { PromptContentPart } from '@deepseek-ai/dsh-api-session-controller/types'
import type { UserQuestionProjectionView, PendingUserQuestion } from '@deepseek-ai/dsh-user-questions/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionReference, SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { InvocationDescriptor, TypertClientEventListener } from '@deepseek-ai/dsh-typert-protocol'
import { ApiTransport } from './transport.ts'

/** A keyboard-accessible action supplied by the core frontend or an extension. */
export interface TuiAction {
  readonly id: string
  readonly label: string
  readonly description?: string
  run(): void | Promise<void>
}

/** An interactive request is transient; the existing gateway owns settlement. */
export interface Interaction {
  readonly id: number
  readonly sessionId: SessionId | undefined
  readonly title: string
  readonly detail: string
  readonly options: readonly string[]
  /** Keep a foreground wait open after deliberate user interaction. */
  engage?(): void
  answer(value: string): void
  delegate(): void
}

type ApprovalListener = TypertClientEventListener<'approval/request'>
const DELEGATE_QUESTION = Symbol('delegate-question')

type QuestionListener = TypertClientEventListener<'user-questions/request'>

/** Sole owner of client state, remote subscriptions, and action/renderer registrations. */
export class TuiModel {
  /** Client Cordis context; it mounts no Host services. */
  readonly ctx = new Context()
  /** Unsettled requests forwarded by the existing gateway. */
  readonly interactions: Interaction[] = []
  /** Frontend commands registered for the action palette. */
  readonly actions = new Map<string, TuiAction>()
  /** Terminal renderers keyed by shared Chat node kind. */
  readonly renderers = new Map<string, (data: unknown) => readonly string[]>()
  /** Session-local prompt text; never synchronized to other frontends. */
  readonly drafts = new Map<string, string>()
  /** Staged content in the draft's original attachment order. */
  readonly attachments = new Map<string, PromptContentPart[]>()
  /** Frontend observers; remove subscriptions when their owner disposes. */
  readonly changed = new Set<() => void>()
  /** Currently retained Session, without ownership of its Host Agent. */
  binding: SessionBinding | undefined
  /** Shared conversation projection for the current Session. */
  conversation: ConversationBinding | undefined
  /** Monotonic invalidation key for the selected Chat projection's live node readers. */
  chatRevision = 0
  /** Host-backed delivery preference used while the Agent is running. */
  busyEnter: BusyEnterBehavior = DEFAULT_BUSY_ENTER_BEHAVIOR
  private preferenceRead = 0
  /** Current client connection phase. */
  state = 'connecting'
  /** Latest actionable diagnostic for the status line. */
  message = ''
  /** Structured result of the latest management action. */
  result = ''
  private reference: SessionReference | undefined
  private selection = 0
  private subscription: (() => void) | undefined
  private questionSubscription: (() => void) | undefined
  private conversationSubscription: (() => void) | undefined
  private interactionId = 0
  private readonly operations = new Set<AbortController>()

  constructor(
    readonly transport: ApiTransport,
    /** Retained management-stream characters; omission leaves low-level clients unbounded. */
    readonly maxStreamCharacters?: number,
  ) {}

  /** Instance-local Connection installed by the shared client service. */
  get connection(): ConnectionHandle {
    return this.ctx.get('connection') as ConnectionHandle
  }

  /** Mount the same React-free client services used by the Web application. */
  async start(): Promise<void> {
    await this.transport.authenticate()
    installConnection(this.ctx, {
      interactions: 'answer',
      transport: this.transport.hooks(),
      onDiagnostic: (_level, message) => {
        this.message = message
        this.notify()
      },
    })
    await this.ctx.plugin(registry)
    await this.ctx.plugin(gateway)
    await this.ctx.plugin(remotes)
    await this.ctx.plugin(uploads)
    await this.ctx.plugin(sessions)
    await this.ctx.plugin(workspaces)
    await this.ctx.plugin(terminals)
    new UiConversation(this.ctx, this.ctx.sessions)
    registerConversationNodes(this.ctx)
    this.ctx.effect(
      () =>
        this.ctx.sessions.list.subscribe(() => {
          this.notify()
        }),
      t('tuiSessionList'),
    )
    this.ctx.effect(
      () =>
        this.ctx.workspaces.list.subscribe(() => {
          this.notify()
        }),
      t('tuiWorkspaceList'),
    )
    this.ctx.effect(
      () =>
        this.connection.state.subscribe(() => {
          this.state = this.connection.state.getSnapshot() ?? 'disconnected'
          this.notify()
        }),
      t('tuiConnectionState'),
    )
    const answerApproval = this.approval.bind(this)
    const answerQuestion = this.question.bind(this)
    this.ctx.remote.$on('approval/request', function (request, next) {
      return answerApproval(this, request, next)
    })
    this.ctx.remote.$on('user-questions/request', function (request, next) {
      return answerQuestion(this, request, next)
    })
    if (this.connection.generation.getSnapshot() === undefined) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          stop()
          reject(new Error(t('theHarnessDidNotFinishItsAPI')))
        }, this.transport.timeoutMs)
        const stop = this.connection.generation.subscribe(() => {
          if (this.connection.generation.getSnapshot() === undefined) return
          clearTimeout(timeout)
          stop()
          resolve()
        })
      })
    }
    this.state = 'connected'
    this.ctx.remote.$on('settings/document-updated', () => {
      void this.refreshPreferences().catch((error: unknown) => {
        this.message = String(error)
        this.notify()
      })
    })
    this.ctx.on('connection/reset', () => {
      void this.refreshPreferences().catch((error: unknown) => {
        this.message = String(error)
        this.notify()
      })
    })
    await this.refreshPreferences()
    await this.ctx.sessions.refresh()
  }

  /** Publish a frontend-only state change. */
  notify(): void {
    for (const listener of this.changed) listener()
  }

  /** Select and retain one existing Session without activating another backend.
   * @param id - existing Host Session identity. */
  async select(id: SessionId): Promise<void> {
    const generation = ++this.selection
    const reference = this.ctx.sessions.retain(id, { source: 'tui' })
    try {
      const binding = await reference.ready
      if (generation !== this.selection) {
        reference.release()
        return
      }
      this.questionSubscription?.()
      this.subscription?.()
      this.conversationSubscription?.()
      this.reference?.release()
      this.reference = reference
      this.binding = binding
      this.conversation = this.ctx.uiConversation.binding(binding)
      this.conversation.activate('chat')
      this.chatRevision++
      this.subscription = binding.session.subscribe(() => {
        this.notify()
      })
      this.questionSubscription = binding.session.projections.faceOf('userQuestions').subscribe(() => {
        this.notify()
      })
      this.conversationSubscription = this.conversation.snapshot.subscribe(() => {
        this.chatRevision++
        this.notify()
      })
      this.notify()
    } catch (error) {
      reference.release()
      throw error
    }
  }

  /** The existing shared Chat assembly supplies both live and recorded rows.
   * @returns the selected Chat projection, when one is retained. */
  chat(): ChatSnapshot | undefined {
    return this.conversation?.target('chat').getSnapshot()
  }

  /** Resolve the same busy-Enter preference used by the Web composer.
   * @param accelerated - use the complement of the preferred busy mode.
   * @returns the Host admission delivery mode. */
  deliveryMode(accelerated: boolean): 'queue' | 'steer' {
    return resolveSubmitMode(
      this.busyEnter,
      this.binding?.session.getSnapshot().running ?? false,
      accelerated ? 'accelerated' : 'enter',
      true,
    )
  }

  private async refreshPreferences(): Promise<void> {
    const read = ++this.preferenceRead
    const result = await this.ctx.remote.settings.describe()
    if (!result.ok) throw new Error(result.error.message)
    if (read !== this.preferenceRead) return
    const value = result.value.namespaces.find(item => item.ns === 'ui-conversation')?.value
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      (value.busyEnter === 'queue' || value.busyEnter === 'steer')
    )
      this.busyEnter = value.busyEnter
    this.notify()
  }

  /** Submit literal content or a slash command with the normal Host admission rules.
   * @param text - literal draft text.
   * @param mode - queue or steer delivery. */
  async send(text: string, mode: 'queue' | 'steer'): Promise<void> {
    const binding = this.binding
    if (!binding) throw new Error(t('selectOrCreateASessionFirst'))
    if (this.state !== 'connected') throw new Error(t('disconnectedDraftPreservedReconnectBeforeSending'))
    const attachments = [...(this.attachments.get(binding.sessionId) ?? [])]
    if (text.trim().length === 0 && attachments.length === 0) return
    let commandHandled = false
    if (text.startsWith('/')) {
      const response = await this.ctx.remote.commands.execute(
        binding.sessionId,
        text,
        attachments.filter(part => part.type !== 'text'),
      )
      if (!response.ok) throw new Error(response.error.message)
      commandHandled = response.value !== undefined
    }
    if (!commandHandled) {
      const submission = binding.session.beginSubmission({ mode, text, attachments: [] })
      const result = await binding.session.prompt(
        [{ type: 'text', text }, ...attachments],
        mode,
        undefined,
        submission.requestId,
      )
      if (!result.ok) throw new Error(result.error.message)
    }
    const remaining = (this.attachments.get(binding.sessionId) ?? []).filter(part => !attachments.includes(part))
    if (remaining.length === 0) this.attachments.delete(binding.sessionId)
    else this.attachments.set(binding.sessionId, remaining)
    if (this.drafts.get(binding.sessionId) === text) this.drafts.delete(binding.sessionId)
    this.notify()
  }

  /** Register an extension action and return its exact disposer.
   * @param action - palette entry owned by the caller.
   * @returns removal of this exact registration. */
  registerAction(action: TuiAction): () => void {
    if (this.actions.has(action.id)) throw new Error(t('actionAlreadyRegistered', [action.id]))
    this.actions.set(action.id, action)
    this.notify()
    return () => {
      if (this.actions.get(action.id) === action) this.actions.delete(action.id)
      this.notify()
    }
  }

  /** Register a renderer for extension-owned Chat data.
   * @param kind - shared Chat node kind.
   * @param renderer - pure text projection of that kind's data.
   * @returns removal of this exact registration. */
  registerRenderer(kind: string, renderer: (data: unknown) => readonly string[]): () => void {
    if (this.renderers.has(kind)) throw new Error(t('rendererAlreadyRegistered', [kind]))
    this.renderers.set(kind, renderer)
    this.notify()
    return () => {
      if (this.renderers.get(kind) === renderer) this.renderers.delete(kind)
      this.notify()
    }
  }

  /** Descriptor-backed actions cover every method selected by the existing Remote facade.
   * @returns the selected generated descriptors. */
  methods(): readonly InvocationDescriptor[] {
    return this.ctx.typert.remotes.list()
  }

  /** Invoke an existing generated method; never construct a second wire protocol.
   * @param descriptor - registered Remote method.
   * @param values - user-entered values keyed by generated parameter wire name. */
  async invoke(descriptor: InvocationDescriptor, values: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.state !== 'connected') throw new Error(t('disconnectedReconnectBeforePerformingAnAction'))
    const scope = descriptor.invocation.kind === 'context' ? this.binding?.ctx : this.ctx
    if (!scope) throw new Error(t('selectASessionForThisAction'))
    const namespace: unknown = Reflect.get(scope.remote, descriptor.namespace)
    if (typeof namespace !== 'object' || namespace === null) throw new Error(t('thisActionIsNotAvailableOnThe'))
    const method: unknown = Reflect.get(namespace, descriptor.method)
    if (typeof method !== 'function') throw new Error(t('thisActionIsNotAvailableOnThe'))
    const args = descriptor.parameters.map((parameter) => {
      const value = values[parameter.wire]
      if (value === undefined && !parameter.acceptsUndefined) throw new Error(t('enter', [parameter.name]))
      if (parameter.codec.mode === 'strict' && value !== undefined) return parameter.codec.create().parse(value)
      return value
    })
    const operation = new AbortController()
    this.operations.add(operation)
    this.result = ''
    this.notify()
    try {
      const result: unknown = await Reflect.apply(method, namespace, [
        ...args,
        ...(descriptor.cancellation ? [operation.signal] : []),
      ])
      if (isAsyncIterable(result)) {
        let history = ''
        let truncated = false
        const marker = t('earlierStreamOutputOmitted')
        for await (const frame of result) {
          history += (history ? '\n\n' : '') + pretty(frame)
          const limit = this.maxStreamCharacters
          if (limit !== undefined && history.length > limit - marker.length - 1) {
            history = history.slice(-(limit - marker.length - 1)).replace(/^[\uDC00-\uDFFF]/u, '')
            truncated = true
          }
          this.result = truncated ? marker + '\n' + history : history
          this.notify()
        }
      } else {
        this.result = pretty(result)
        this.notify()
      }
    } finally {
      this.operations.delete(operation)
    }
  }

  /** Stop frontend observation, without replaying or reversing any Host mutation. */
  cancelObservation(): void {
    for (const operation of this.operations) operation.abort()
  }

  /** Disconnect and release only frontend-owned resources. */
  async dispose(): Promise<void> {
    this.selection++
    this.cancelObservation()
    this.questionSubscription?.()
    this.subscription?.()
    this.conversationSubscription?.()
    this.reference?.release()
    await this.ctx.fiber.dispose()
    this.transport.dispose()
  }

  /** Answerable calls whose foreground wait has ended.
   * @returns continued questions in Host ask order.
   */
  pendingQuestions(): readonly PendingUserQuestion[] {
    const projected = this.binding?.session.projections.faceOf('userQuestions').getSnapshot() as
      | UserQuestionProjectionView
      | undefined
    return projected?.active.filter(row => row.state === 'continued') ?? []
  }

  /** Reply to an unanswered continued call through its existing Remote method.
   * @param question - pending row from the current Session projection.
   */
  async answerPending(question: PendingUserQuestion): Promise<void> {
    const binding = this.binding
    if (!binding) throw new Error(t('selectASessionFirst'))
    const lifetime = new AbortController()
    const dispose = binding.ctx.effect(
      () => () => {
        lifetime.abort()
      },
      'tui: continued question',
    )
    try {
      const answer = await this.question(
        binding.ctx,
        { questions: [...question.questions], signal: lifetime.signal },
        () => Promise.resolve({ answers: [] }),
      )
      if (answer.answers.length === 0) return
      const result = await this.ctx.remote.userQuestions.answer(binding.sessionId, question.callId, answer)
      if (!result.ok) throw new Error(result.error.message)
    } finally {
      await dispose()
    }
  }

  private approvalCall(sessionId: SessionId, callId: string | undefined): string {
    const binding = this.ctx.sessions.binding(sessionId)
    if (!binding || !callId) return ''
    const conversation = this.ctx.uiConversation.binding(binding)
    conversation.activate('chat')
    const call = conversation
      .target('chat')
      .getSnapshot()
      ?.legacy.runningCalls.find(call => call.callId === callId)
    return call && 'argsRaw' in call ? `${call.name}\n${call.argsRaw}` : ''
  }

  private approval(
    owner: Context,
    request: Parameters<ApprovalListener>[0],
    next: Parameters<ApprovalListener>[1],
  ): ReturnType<ApprovalListener> {
    const sessionId = this.ctx.sessions.scopeOf(owner)
    if (sessionId === undefined) return next()
    return this.interact(
      {
        sessionId,
        title: t('approval', [request.toolName]),
        detail: [request.reason ?? '', this.approvalCall(sessionId, request.callId)].filter(Boolean).join('\n'),
        options: [t('allowOnce'), t('reject')],
      },
      request.signal,
      value => (value === t('allowOnce') ? 'allowed-once' : 'rejected'),
      next,
    )
  }

  private async question(
    owner: Context,
    request: Parameters<QuestionListener>[0],
    next: Parameters<QuestionListener>[1],
  ): ReturnType<QuestionListener> {
    const sessionId = this.ctx.sessions.scopeOf(owner)
    if (sessionId === undefined) return next()
    const claimLifetime = new AbortController()
    const claimSignal = request.signal ? AbortSignal.any([request.signal, claimLifetime.signal]) : claimLifetime.signal
    const callId = request.wait?.callId
    const claim =
      request.wait?.timed === true && callId !== undefined
        ? this.ctx.remote.userQuestions.attachWait(sessionId, callId, claimSignal)
        : undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    const waitState = { expired: false }
    let answered = false
    let claimEnded: Promise<void> | undefined
    try {
      const iterator = claim?.[Symbol.asyncIterator]()
      const opening = await iterator?.next()
      if (opening?.done) return await next()
      claimEnded = iterator?.next().then(
        () => undefined,
        () => undefined,
      )
      if (opening)
        timeout = setTimeout(() => {
          waitState.expired = true
          claimLifetime.abort()
        }, opening.value.remainingMs)
      const answers: Array<{ id: string; selected: string[]; custom?: string }> = []
      for (const question of request.questions) {
        const descriptions =
          question.options
            ?.filter(option => option.description)
            .map(option => `${option.label}: ${option.description}`)
            .join('\n') ?? ''
        const answer = await this.interact<string | typeof DELEGATE_QUESTION>(
          {
            sessionId,
            title: question.header ?? question.question,
            detail: [
              question.question,
              question.detail ?? '',
              descriptions,
              question.multiSelect ? t('selectSeveralLabelsSeparatedByCommasOr') : '',
            ]
              .filter(Boolean)
              .join('\n'),
            options: question.options?.map(option => option.label) ?? [],
            ...(opening
              ? {
                engage: () => {
                  clearTimeout(timeout)
                  timeout = undefined
                },
              }
              : {}),
          },
          claimSignal,
          value => value,
          () => Promise.resolve(DELEGATE_QUESTION),
        )
        if (answer === DELEGATE_QUESTION) return await next()
        const options = question.options?.map(option => option.label) ?? []
        const selected = options.includes(answer)
          ? [answer]
          : question.multiSelect
            ? answer
              .split(',')
              .map(item => item.trim())
              .filter(item => options.includes(item))
            : []
        answers.push({ id: question.id, selected, ...(selected.length === 0 ? { custom: answer } : {}) })
      }
      answered = true
      return { answers }
    } catch (error) {
      if (!waitState.expired) throw error
      this.message = t('questionWaitExpired')
      this.notify()
      return await next()
    } finally {
      clearTimeout(timeout)
      if (!answered || request.signal?.aborted) {
        claimLifetime.abort()
        claim?.dispose()
      } else if (claimEnded)
        void claimEnded.finally(() => {
          claimLifetime.abort()
          claim?.dispose()
        })
    }
  }

  private interact<Result>(
    data: Omit<Interaction, 'id' | 'answer' | 'delegate'>,
    signal: AbortSignal | undefined,
    project: (value: string) => Result,
    next: () => Promise<Result>,
  ): Promise<Result> {
    return new Promise((resolve, reject) => {
      let settled = false
      const remove = (): void => {
        const index = this.interactions.indexOf(interaction)
        if (index >= 0) this.interactions.splice(index, 1)
        signal?.removeEventListener('abort', abort)
        this.notify()
      }
      const abort = (): void => {
        if (settled) return
        settled = true
        remove()
        reject(
          signal?.reason instanceof Error ? signal.reason : new Error(t('requestCancelled'), { cause: signal?.reason }),
        )
      }
      const interaction: Interaction = {
        ...data,
        id: ++this.interactionId,
        answer: (value) => {
          if (settled) return
          settled = true
          remove()
          resolve(project(value))
        },
        delegate: () => {
          if (settled) return
          settled = true
          remove()
          resolve(next())
        },
      }
      if (signal?.aborted) {
        reject(
          signal.reason instanceof Error ? signal.reason : new Error(t('requestCancelled'), { cause: signal.reason }),
        )
        return
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.interactions.push(interaction)
      this.notify()
    })
  }
}

/** Safe structured fallback for a feature without a terminal-specific renderer. */
export function pretty(value: unknown): string {
  if (value === undefined || typeof value === 'symbol' || typeof value === 'function') return String(value)
  return JSON.stringify(
    value,
    (_key, item: unknown): unknown =>
      item instanceof Uint8Array ? { bytes: item.byteLength } : item instanceof Map ? Object.fromEntries(item) : item,
    2,
  )
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    tui: unknown
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tui: TuiModel
  }
}
