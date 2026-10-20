/** Full-screen keyboard/mouse shell for one shared harness client. */
import { t } from './copy.ts'

import termkit from 'terminal-kit'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, open, link, unlink } from 'node:fs/promises'
import { basename } from 'node:path'
import { spawn } from 'node:child_process'
import xterm from '@xterm/headless'
import type { TerminalView } from '@deepseek-ai/dsh-api-terminal-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { PasteDecoder } from './paste.ts'
import { DraftEditor } from './editor.ts'
import { TuiModel, pretty, type TuiAction, type Interaction } from './model.ts'
import { sidebarRows, workspaceForSession, type SidebarRow } from './navigation.ts'
import {
  presentTranscript, record, safeText, sessionMetricsLine, transcript, wrapText, type TranscriptMode,
} from './presenter.ts'
import {
  changesDiffUrl, changesKey, changesSummaryUrl, decodeChangesDiff, decodeChangesSummary,
  type ChangesDiffState, type ChangesSummaryState, type TurnChangesPresentation,
} from './changes.ts'

interface MenuItem {
  label: string
  detail?: string | undefined
  run(): void | Promise<void>
}
interface Menu {
  title: string
  items: MenuItem[]
  index: number
  emptyMessage?: string
}
interface FormField {
  key: string
  label: string
  value: string
  optional: boolean
  json: boolean
  secret?: boolean
}
interface Form {
  title: string
  detail: string
  fields: FormField[]
  index: number
  run(values: Record<string, unknown>): void | Promise<void>
}
type Focus = 'sessions' | 'chat' | 'composer' | 'detail'
type TranscriptRenderer = (data: unknown) => readonly string[]
interface TranscriptCache {
  snapshot: ReturnType<TuiModel['chat']>
  chatRevision: number
  rendererEntries: ReadonlyArray<readonly [string, TranscriptRenderer]>
  width: number
  mode: TranscriptMode
  expansionRevision: number
  changesRevision: number
  rows: string[]
  toolRows: Map<number, string>
  changeRows: Map<number, string>
}
const activityFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/** Frontend layout, local drafts, and terminal emulation; owns no backend processes. */
export class TuiView {
  private readonly term = termkit.terminal
  private screen: termkit.ScreenBuffer | undefined
  private pasteDecoder: PasteDecoder | undefined
  private keyHandler: ((bytes: Buffer) => void) | undefined
  private readonly draft = new DraftEditor()
  private readonly answerDraft = new DraftEditor()
  private readonly input = new DraftEditor()
  private mode: 'NORMAL' | 'INSERT' | 'TERMINAL' = 'NORMAL'
  private focus: Focus = 'sessions'
  private scroll = 0
  private detailScroll = 0
  private detailRows: string[] = []
  private sidebarIndex = 0
  private sidebarKey: SidebarRow['key'] | undefined
  private readonly expandedWorkspaces = new Set<WorkspaceId>()
  private pendingRevealSession: SessionId | undefined
  private transcriptMode: TranscriptMode = 'clean'
  private menu: Menu | undefined
  private form: Form | undefined
  private command: ':' | '/' | undefined
  private showHelp = false
  private showDetail = false
  private readonly terminalTabs: Array<{ sessionId: SessionId; tabId: string; contentId: string }> = []
  private terminal:
    | { view: TerminalView; emulator: xterm.Terminal; stop: () => void; unsubscribe: () => void; revision: number }
    | undefined
  private frame: ReturnType<typeof setTimeout> | undefined
  private activityFrame: ReturnType<typeof setTimeout> | undefined
  private interaction: Interaction | undefined
  private interactionIndex = 0
  private interactionDetailScroll = 0
  private prefix = ''
  private readonly lifetime = new AbortController()
  private readonly downloads = new Set<Promise<void>>()
  private closed = false
  private readonly done = Promise.withResolvers<void>()
  private readonly actionDisposers: Array<() => void> = []
  private sideWidth = 0
  private chatHeight = 0
  private composerY = 0
  private sidebarWidth = 28
  private dragging = false
  private selectedText = ''
  private selectionStart: number | undefined
  private contentRows: string[] = []
  private toolContentRows = new Map<number, string>()
  private changeContentRows = new Map<number, string>()
  private readonly expandedTools = new Set<string>()
  private readonly expandedChanges = new Set<string>()
  private toolExpansionRevision = 0
  private pendingToolAnchor: { key: string; viewportRow: number } | undefined
  private pendingChangeAnchor: { key: string; viewportRow: number } | undefined
  private readonly changeSummaries = new Map<string, ChangesSummaryState>()
  private readonly changeDiffs = new Map<string, ChangesDiffState>()
  private readonly changeCoordinates = new Map<string, { sessionId: SessionId; seq: number }>()
  private changesRevision = 0
  private transcriptCache: TranscriptCache | undefined
  private search = ''

  constructor(
    readonly model: TuiModel,
    private readonly options: { mouse: boolean; frameMs: number; escapeDelayMs: number },
  ) {}

  /** Start alternate-screen rendering and return when the user disconnects. */
  async run(): Promise<void> {
    this.term.fullscreen(true)
    this.term.hideCursor()
    this.term.grabInput({ mouse: this.options.mouse ? 'drag' : undefined })
    this.installPaste()
    this.term('\x1b[?2004h')
    this.term.on('key', this.onKey)
    this.term.on('mouse', this.onMouse)
    this.term.on('resize', this.onResize)
    this.term.on('terminal', this.onTerminal)
    process.on('SIGINT', this.onExit)
    process.on('SIGTERM', this.onExit)
    process.on('SIGTSTP', this.onSuspend)
    process.on('SIGCONT', this.onResume)
    this.model.changed.add(this.invalidate)
    try {
      this.installActions()
      this.resize()
      await this.done.promise
    } finally {
      this.restore()
      await Promise.allSettled([...this.downloads])
    }
  }

  /** Schedule at most one screen update per configured frame interval. */
  readonly invalidate = (): void => {
    if (this.closed || this.frame) return
    this.frame = setTimeout(() => {
      this.frame = undefined
      try {
        this.render()
      } catch (error) {
        this.done.reject(error)
      }
    }, this.options.frameMs)
  }

  /** Stop frontend rendering and return control to the profile. */
  close(): void {
    this.done.resolve()
  }

  private readonly onExit = (): void => {
    this.close()
  }
  private readonly onResize = (): void => {
    try {
      this.resize()
    } catch (error) {
      this.done.reject(error)
    }
  }
  private readonly onTerminal = (name: string, data: unknown): void => {
    if (name !== 'paste' || !record(data) || typeof data.text !== 'string') return
    this.editor().insert(data.text.replace(/\r\n?/g, '\n'))
    this.persistDraft()
    this.invalidate()
  }
  private readonly onSuspend = (): void => {
    this.releaseTerminal()
    process.kill(process.pid, 'SIGSTOP')
  }
  private readonly onResume = (): void => {
    this.term.fullscreen(true)
    this.term.hideCursor()
    this.term.grabInput({ mouse: this.options.mouse ? 'drag' : undefined })
    this.installPaste()
    this.term('\x1b[?2004h')
    this.resize()
  }

  private resize(): void {
    const width = Math.max(1, this.term.width)
    const height = Math.max(1, this.term.height)
    this.screen = new termkit.ScreenBuffer({ dst: this.term, width, height })
    this.terminal?.emulator.resize(Math.max(2, width - 2), Math.max(2, height - 4))
    this.terminal?.view.resize(Math.max(2, width - 2), Math.max(2, height - 4))
    this.render()
  }

  private render(): void {
    const screen = this.screen
    if (!screen || this.closed) return
    const width = screen.width,
      height = screen.height
    screen.fill({ attr: { color: 'white', bgColor: 'black' }, char: ' ' })
    if (width < 24 || height < 8) {
      this.scheduleActivityFrame(false)
      this.line(0, 0, t('enlargeThisTmuxPaneMinimum'), width, 'yellow')
      screen.draw({ delta: true })
      return
    }
    const running = this.model.binding?.session.getSnapshot().running ?? false
    const sessionId = this.model.binding?.sessionId
    const title = sessionId
      ? (this.model.ctx.sessions.list.getSnapshot().byId[sessionId]?.displayTitle ?? sessionId)
      : t('noSession')
    this.line(0, 0, t('deepseek', [title]), width, 'cyan', 'blue')
    const status = `${this.mode} · ${this.model.state} · ${this.focus} · ${this.transcriptMode}${this.model.pendingQuestions().length ? ' · :questions' : ''}`
    this.line(Math.max(0, width - status.length - 2), 0, status, status.length + 1, 'white', 'blue')
    this.sideWidth = width >= 80 ? Math.min(this.sidebarWidth, Math.floor(width / 3)) : 0
    const composerHeight = Math.min(Math.max(4, this.draft.text.split('\n').length + 2), Math.floor(height / 3))
    this.composerY = height - composerHeight - 2
    this.chatHeight = Math.max(1, this.composerY - 2)
    const detailWidth = this.showDetail && width >= 110 ? Math.floor((width - this.sideWidth) / 3) : 0
    this.scheduleActivityFrame(running && this.terminal === undefined && !(this.focus === 'detail' && !detailWidth))
    const contentWidth = width - this.sideWidth - detailWidth - 2
    const navigation = this.navigationRows()
    if (this.sideWidth) {
      this.line(0, 1, t('workspacesNNew'), this.sideWidth, this.focus === 'sessions' ? 'cyan' : 'gray')
      const top = Math.max(0, this.sidebarIndex - (height - 6))
      for (let row = 0; row < height - 4; row++) {
        const item = navigation[top + row]
        if (!item) break
        const selected = top + row === this.sidebarIndex
        const label = item.kind === 'workspace'
          ? ` ${item.expanded ? '▾' : '▸'} ${item.title}`
          : `   ${item.sessionId === sessionId ? '▸' : ' '} ${item.running ? '● ' : ''}${item.title}`
        this.line(
          0,
          row + 2,
          label,
          this.sideWidth - 1,
          selected ? 'black' : 'white',
          selected ? 'cyan' : 'black',
        )
      }
      for (let y = 1; y < height - 1; y++) this.line(this.sideWidth - 1, y, '│', 1, 'gray')
    }
    this.line(this.sideWidth + 1, 1, sessionMetricsLine(this.model.sessionMetrics()), contentWidth, 'gray')
    if (this.focus === 'detail' && !detailWidth) {
      this.contentRows = this.model.result.split('\n').flatMap(row => wrapText(row, contentWidth))
      this.toolContentRows = new Map()
      this.changeContentRows = new Map()
    } else {
      const conversation = this.conversationRows(contentWidth)
      const activity = activityFrames[Math.floor(Date.now() / 100) % activityFrames.length] ?? activityFrames[0]
      this.contentRows = running ? [...conversation.rows, `── ${activity} ${t('working')} ──`] : conversation.rows
      this.toolContentRows = conversation.toolRows
      this.changeContentRows = conversation.changeRows
      const toolAnchor = this.pendingToolAnchor
      if (toolAnchor !== undefined) {
        const header = [...conversation.toolRows].find(([, key]) => key === toolAnchor.key)?.[0]
        if (header !== undefined) {
          const desiredStart = Math.max(0, header - toolAnchor.viewportRow)
          this.scroll = Math.max(0, this.contentRows.length - this.chatHeight - desiredStart)
        }
        this.pendingToolAnchor = undefined
      }
      const changeAnchor = this.pendingChangeAnchor
      if (changeAnchor !== undefined) {
        const header = [...conversation.changeRows].find(([, key]) => key === changeAnchor.key)?.[0]
        if (header !== undefined) {
          const desiredStart = Math.max(0, header - changeAnchor.viewportRow)
          this.scroll = Math.max(0, this.contentRows.length - this.chatHeight - desiredStart)
        }
        this.pendingChangeAnchor = undefined
      }
    }
    const start =
      this.focus === 'detail' && !detailWidth
        ? this.detailScroll
        : Math.max(0, this.contentRows.length - this.chatHeight - this.scroll)
    for (let y = 0; y < this.chatHeight; y++) {
      const row = this.contentRows[start + y] ?? ''
      this.line(
        this.sideWidth + 1,
        y + 2,
        row,
        contentWidth,
        row.startsWith('+')
          ? 'green'
          : row.startsWith('-')
            ? 'red'
            : row.startsWith('@@')
              ? 'yellow'
              : row.startsWith('──') || row.startsWith('┌─') || row.startsWith('└─')
                ? 'cyan'
                : row.startsWith('◆ ')
                  ? 'yellow'
                  : row.startsWith('│ ')
                    ? 'gray'
                    : this.search && row.includes(this.search)
                      ? 'yellow'
                      : 'white',
      )
    }
    if (detailWidth) {
      const x = width - detailWidth
      this.line(x, 1, t('detailsACTIONRESULT'), detailWidth, 'cyan')
      const detail = this.model.result || pretty(this.model.binding?.session.getSnapshot())
      this.detailRows = wrapText(detail, detailWidth - 2)
      this.detailRows.slice(this.detailScroll, this.detailScroll + height - 4).forEach((row, i) => {
        this.line(x + 1, i + 2, row, detailWidth - 2)
      })
    }
    const attachmentCount = sessionId ? (this.model.attachments.get(sessionId)?.length ?? 0) : 0
    this.line(
      this.sideWidth + 1,
      this.composerY,
      t('prompt', [
        attachmentCount ? `(${attachmentCount} attachments) ` : '',
        this.mode === 'INSERT' ? '[Enter send · Ctrl-j newline]' : '[i edit]',
      ]),
      width - this.sideWidth - 2,
      'cyan',
    )
    const draftLines = wrapText(this.draft.text || ' ', width - this.sideWidth - 4)
    draftLines.slice(-composerHeight + 1).forEach((row, i) => {
      this.line(this.sideWidth + 2, this.composerY + 1 + i, row, width - this.sideWidth - 4)
    })
    this.line(0, height - 2, this.model.message || t('paletteSessionsFilesSettingsTerminalStopQ'), width, 'gray')
    this.line(0, height - 1, t('hjklNavigateTabFocusSearchMouseEnabled'), width, 'black', 'cyan')
    if (this.terminal) this.renderTerminal(width, height)
    this.updateInteraction()
    if (this.menu) this.renderMenu(width, height)
    if (this.form) this.renderForm(width, height)
    if (this.showHelp) this.renderHelp(width, height)
    if (this.interaction) this.renderInteraction(width, height)
    if (this.command) this.line(0, height - 1, `${this.command}${this.input.text}`, width, 'white', 'blue')
    screen.draw({ delta: true })
    if (
      (this.mode === 'INSERT' && !this.menu && !this.form && !this.interaction && !this.command) ||
      this.command ||
      this.form
    ) {
      const editor = this.editor()
      const before = editor.text.slice(0, editor.cursor)
      const lines = wrapText(before, width - this.sideWidth - 4)
      const x = this.command
        ? termkit.stringWidth(this.input.text.slice(0, this.input.cursor)) + 2
        : this.form
          ? 3
          : this.sideWidth + 3 + termkit.stringWidth(lines.at(-1) ?? '')
      const y = this.command
        ? height
        : this.form
          ? Math.min(height - 2, 7 + this.form.index * 3)
          : Math.min(height - 2, this.composerY + 2 + lines.length - 1)
      this.term.moveTo(Math.min(width, x), Math.max(1, y))
      this.term.hideCursor(false)
    } else this.term.hideCursor()
  }

  private line(x: number, y: number, text: string, width: number, color = 'white', bgColor = 'black'): void {
    if (!this.screen || y < 0 || y >= this.screen.height || x >= this.screen.width) return
    this.screen.put(
      { x, y, attr: { color, bgColor }, wrap: false, dx: 1, dy: 0 },
      termkit.truncateString(safeText(text), Math.max(0, width)),
    )
  }

  private scheduleActivityFrame(running: boolean): void {
    if (!running) {
      if (this.activityFrame !== undefined) clearTimeout(this.activityFrame)
      this.activityFrame = undefined
      return
    }
    if (this.activityFrame !== undefined) return
    this.activityFrame = setTimeout(() => {
      this.activityFrame = undefined
      this.invalidate()
    }, 100)
  }

  private conversationRows(width: number): Pick<TranscriptCache, 'rows' | 'toolRows' | 'changeRows'> {
    const snapshot = this.model.chat()
    const turnChanges = this.turnChanges()
    const rendererEntries = [...this.model.renderers.entries()]
    const cached = this.transcriptCache
    if (
      cached !== undefined &&
      cached.snapshot === snapshot &&
      cached.chatRevision === this.model.chatRevision &&
      cached.width === width &&
      cached.mode === this.transcriptMode &&
      cached.expansionRevision === this.toolExpansionRevision &&
      cached.changesRevision === this.changesRevision &&
      sameRendererEntries(cached.rendererEntries, rendererEntries)
    ) return cached

    const presentation = presentTranscript(
      snapshot, this.model.renderers, this.transcriptMode, this.expandedTools, turnChanges,
    )
    const rows: string[] = []
    const toolRows = new Map<number, string>()
    const changeRows = new Map<number, string>()
    presentation.rows.forEach((row, sourceRow) => {
      const tool = presentation.toolRows.get(sourceRow)
      if (tool !== undefined) toolRows.set(rows.length, tool)
      const changes = presentation.changeRows.get(sourceRow)
      if (changes !== undefined) changeRows.set(rows.length, changes)
      rows.push(...wrapText(row, width))
    })
    if (rows.length === 0) rows.push(t('selectASessionOrPressNTo'), '', t('iWriteActionsSpaceSpacePaletteHelp'))
    const next: TranscriptCache = {
      snapshot,
      chatRevision: this.model.chatRevision,
      rendererEntries,
      width,
      mode: this.transcriptMode,
      expansionRevision: this.toolExpansionRevision,
      changesRevision: this.changesRevision,
      rows,
      toolRows,
      changeRows,
    }
    this.transcriptCache = next
    return next
  }

  private turnChanges(): ReadonlyMap<number, TurnChangesPresentation> {
    const result = new Map<number, TurnChangesPresentation>()
    for (const announcement of this.model.changeAnnouncements().values()) {
      const key = changesKey(announcement.sessionId, announcement.seq)
      this.changeCoordinates.set(key, announcement)
      if (!this.changeSummaries.has(key)) {
        this.changeSummaries.set(key, 'loading')
        void this.loadChangesSummary(key, announcement.sessionId, announcement.seq)
      }
      const diffs = new Map<number, ChangesDiffState>()
      const summary = this.changeSummaries.get(key) ?? 'loading'
      if (typeof summary !== 'string') {
        summary.files.forEach((_file, index) => {
          const state = this.changeDiffs.get(`${key}:${index}`)
          if (state !== undefined) diffs.set(index, state)
        })
      }
      result.set(announcement.turn, {
        key,
        summary,
        expanded: this.expandedChanges.has(key),
        diffs,
      })
    }
    return result
  }

  private async loadChangesSummary(key: string, sessionId: SessionId, seq: number): Promise<void> {
    try {
      const response = await this.model.transport.fetch(changesSummaryUrl(sessionId, seq), {
        signal: this.lifetime.signal,
      })
      const decoded = response.ok ? decodeChangesSummary(await response.json() as unknown) : undefined
      this.changeSummaries.set(key, decoded ?? 'missing')
      if (decoded !== undefined && this.expandedChanges.has(key)) this.loadChangesDiffs(key, decoded.files.length)
    } catch {
      if (!this.lifetime.signal.aborted) this.changeSummaries.set(key, 'missing')
    }
    this.changesRevision++
    this.invalidate()
  }

  private loadChangesDiffs(key: string, count: number): void {
    const coordinates = this.changeCoordinates.get(key)
    if (coordinates === undefined) return
    for (let index = 0; index < count; index++) {
      const diffKey = `${key}:${index}`
      if (this.changeDiffs.has(diffKey)) continue
      this.changeDiffs.set(diffKey, 'loading')
      void this.loadChangesDiff(diffKey, coordinates.sessionId, coordinates.seq, index)
    }
  }

  private async loadChangesDiff(
    key: string,
    sessionId: SessionId,
    seq: number,
    index: number,
  ): Promise<void> {
    try {
      const response = await this.model.transport.fetch(changesDiffUrl(sessionId, seq, index), {
        signal: this.lifetime.signal,
      })
      const decoded = response.ok ? decodeChangesDiff(await response.json() as unknown) : undefined
      this.changeDiffs.set(key, decoded ?? (response.status === 404 ? 'missing' : 'error'))
    } catch {
      if (!this.lifetime.signal.aborted) this.changeDiffs.set(key, 'error')
    }
    this.changesRevision++
    this.invalidate()
  }

  private box(title: string, width: number, height: number): void {
    for (let y = 1; y < height - 1; y++)
      this.line(1, y, ' '.repeat(Math.max(0, width - 2)), width - 2, 'white', 'black')
    this.line(2, 2, title, width - 4, 'cyan')
  }

  private filteredMenu(): MenuItem[] {
    return (
      this.menu?.items.filter(item =>
        `${item.label} ${item.detail ?? ''}`.toLowerCase().includes(this.input.text.toLowerCase()),
      ) ?? []
    )
  }

  private renderMenu(width: number, height: number): void {
    if (!this.menu) return
    const items = this.filteredMenu()
    this.menu.index = Math.max(0, Math.min(this.menu.index, items.length - 1))
    this.box(this.menu.title, width, height)
    this.line(2, 3, t('filter', [this.input.text]), width - 4, 'yellow')
    if (items.length === 0) this.line(2, 5, this.menu.emptyMessage ?? t('noMatchingItems'), width - 4, 'gray')
    const top = Math.max(0, this.menu.index - (height - 9))
    items.slice(top, top + height - 7).forEach((item, index) => {
      this.line(
        2,
        index + 5,
        `${item.label}${item.detail ? `  ${item.detail}` : ''}`,
        width - 4,
        index + top === this.menu?.index ? 'black' : 'white',
        index + top === this.menu?.index ? 'cyan' : 'black',
      )
    })
  }

  private renderForm(width: number, height: number): void {
    const form = this.form
    if (!form) return
    this.box(form.title, width, height)
    this.line(2, 3, form.detail, width - 4, 'gray')
    const fieldTop = Math.max(0, form.index - Math.floor((height - 12) / 3))
    form.fields.slice(fieldTop, fieldTop + Math.max(1, Math.floor((height - 9) / 3))).forEach((field, offset) => {
      const index = offset + fieldTop
      this.line(
        2,
        5 + offset * 3,
        `${field.label}${field.optional ? t('optional') : ''}${field.json ? t('json') : ''}`,
        width - 4,
        index === form.index ? 'cyan' : 'gray',
      )
      const value = index === form.index ? this.input.text : field.value
      this.line(2, 6 + offset * 3, field.secret ? '•'.repeat(value.length) : value, width - 4)
    })
    this.line(2, height - 3, t('tabNextFieldCtrlSSubmitEsc'), width - 4, 'yellow')
  }

  private updateInteraction(): void {
    const next = this.model.interactions[0]
    if (next?.id === this.interaction?.id) return
    this.interaction = next
    this.interactionIndex = 0
    this.interactionDetailScroll = 0
    if (next) this.answerDraft.reset()
  }

  private renderInteraction(width: number, height: number): void {
    const item = this.interaction
    if (!item) return
    this.box(`${item.title} · ${item.sessionId ?? ''}`, width, height)
    const detail = wrapText(item.detail, width - 4)
    detail
      .slice(this.interactionDetailScroll, this.interactionDetailScroll + Math.max(1, Math.floor(height / 2) - 4))
      .forEach((row, i) => {
        this.line(2, i + 4, row, width - 4)
      })
    const optionRows = Math.max(1, height - Math.floor(height / 2) - 6)
    const optionTop = Math.max(0, this.interactionIndex - optionRows + 1)
    item.options.slice(optionTop, optionTop + optionRows).forEach((option, offset) => {
      const index = optionTop + offset
      this.line(
        2,
        Math.floor(height / 2) + offset + 1,
        `${index + 1}. ${option}`,
        width - 4,
        index === this.interactionIndex ? 'cyan' : 'white',
      )
    })
    if (item.engage) this.line(2, height - 4, t('timedQuestionHint'), width - 4, 'gray')
    this.line(2, height - 3, t('custom', [this.answerDraft.text]), width - 4)
    this.line(2, height - 2, t('enterAnswerArrowsChoiceTypeCustomEsc'), width - 4, 'yellow')
  }

  private renderHelp(width: number, height: number): void {
    this.box(t('keyboardHELP'), width, height)
    const rows = [
      t('normalHjklWBGgGCtrl'),
      t('chatDTogglesGitDiff'),
      t('editingArrowsHomeEndCtrlJNewline'),
      t('editingEscNormalUUndoCtrlR'),
      t('tabShiftTabFocusCtrlWH'),
      t('sessionsNewDirectoryRenameTITLEForkOlder'),
      t('filesSettingsModelsPluginsGoalsSchedulesJobs'),
      t('workspacesCommandsActionsInspectResultExportPATH'),
      t('attachPATHImagePATHClearattachmentsDownloadROUTE'),
      t('terminalIdTerminalsTermcloseTerminalinputCtrlReturns'),
      t('mouseReconnectQClosingTheTUILeaves'),
      t('formsUseGeneratedActionParametersComplexValues'),
      t('mouseClickFocusSelectWheelScrollDrag'),
      t('copyCopiesSelectedChatTextUsingTerminal'),
      t('escClosesThisHelpBrowserOnlyVisual'),
    ]
    rows.forEach((row, index) => {
      this.line(2, index + 4, row, width - 4)
    })
  }

  private editor(): DraftEditor {
    if (this.interaction) return this.answerDraft
    return this.command || this.menu || this.form ? this.input : this.draft
  }
  private persistDraft(): void {
    const id = this.model.binding?.sessionId
    if (id && !this.menu && !this.form && !this.command && !this.interaction) this.model.drafts.set(id, this.draft.text)
  }

  private readonly onKey = (
    key: string,
    _matches: unknown,
    data: { isCharacter?: boolean; codepoint?: number; code?: string | number | Buffer } = {},
  ): void => {
    this.handleKey(key, data)
    this.persistDraft()
    this.invalidate()
  }

  private handleKey(key: string, data: { isCharacter?: boolean; code?: string | number | Buffer }): void {
    if (this.mode === 'TERMINAL') {
      if (key === 'CTRL_BACKSLASH') this.mode = 'NORMAL'
      else
        this.terminal?.view.write(
          data.isCharacter
            ? key
            : typeof data.code === 'number'
              ? String.fromCharCode(data.code)
              : typeof data.code === 'string'
                ? data.code
                : (data.code?.toString() ?? terminalKey(key)),
        )
      return
    }
    if (key === 'CTRL_C') {
      if (this.menu || this.form || this.command) this.dismiss()
      else this.close()
      return
    }
    if (key === 'ESCAPE') {
      if (this.interaction) this.interaction.delegate()
      else if (this.menu || this.form || this.command || this.showHelp) this.dismiss()
      else {
        this.mode = 'NORMAL'
        this.draft.anchor = undefined
      }
      return
    }
    if (this.showHelp) return
    if (this.interaction) {
      this.interaction.engage?.()
      if (key === 'PAGE_DOWN' || key === 'CTRL_D') this.interactionDetailScroll += 3
      else if (key === 'PAGE_UP' || key === 'CTRL_U')
        this.interactionDetailScroll = Math.max(0, this.interactionDetailScroll - 3)
      else if (key === 'UP') this.interactionIndex = Math.max(0, this.interactionIndex - 1)
      else if (key === 'DOWN')
        this.interactionIndex = Math.min(this.interaction.options.length - 1, this.interactionIndex + 1)
      else if (key === 'ENTER' || key === 'KP_ENTER') {
        const value = this.answerDraft.text || this.interaction.options[this.interactionIndex]
        if (value) this.interaction.answer(value)
      } else this.edit(this.answerDraft, key, data)
      return
    }
    if (this.command) {
      if (key === 'ENTER') {
        const command = this.command,
          text = this.input.text
        this.command = undefined
        this.input.reset()
        if (command === ':') this.perform(() => this.execute(text))
        else this.find(text)
      } else this.edit(this.input, key, data)
      return
    }
    if (this.form) {
      if (key === 'TAB' || key === 'SHIFT_TAB') {
        const field = this.form.fields[this.form.index]
        if (!field) return
        field.value = this.input.text
        this.form.index =
          (this.form.index + (key === 'TAB' ? 1 : -1) + this.form.fields.length) % this.form.fields.length
        this.input.reset(this.form.fields[this.form.index]?.value ?? '')
      } else if (key === 'CTRL_S' || (key === 'ENTER' && this.form.fields.length === 1)) this.submitForm()
      else this.edit(this.input, key, data)
      return
    }
    if (this.menu) {
      if (key === 'DOWN' || key === 'CTRL_N') this.menu.index++
      else if (key === 'UP' || key === 'CTRL_P') this.menu.index--
      else if (key === 'ENTER') {
        const item = this.filteredMenu()[this.menu.index]
        if (item) {
          this.menu = undefined
          this.input.reset()
          this.perform(() => item.run())
        }
      } else this.edit(this.input, key, data)
      return
    }
    if (key === 'TAB' || key === 'SHIFT_TAB') {
      this.cycleFocus(key === 'TAB' ? 1 : -1)
      return
    }
    if (key === 'CTRL_W' && this.mode === 'NORMAL') {
      this.prefix = 'window'
      return
    }
    if (this.prefix === 'window') {
      this.focus = key === 'h' ? 'sessions' : key === 'l' ? 'detail' : key === 'j' ? 'composer' : 'chat'
      this.prefix = ''
      return
    }
    if (this.mode === 'INSERT') {
      if (key === 'ENTER' || key === 'ALT_ENTER' || key === 'CTRL_S') this.perform(() => this.send(key === 'ALT_ENTER'))
      else this.edit(this.draft, key, data)
      return
    }
    if (key === ':') {
      this.command = ':'
      this.input.reset()
      return
    }
    if (key === '/') {
      this.command = '/'
      this.input.reset()
      return
    }
    if (key === '?') {
      this.showHelp = true
      return
    }
    if (key === ' ') {
      if (this.prefix === 'space') {
        this.palette()
        this.prefix = ''
      } else this.prefix = 'space'
      return
    }
    if (key === 'i' || key === 'a') {
      this.mode = 'INSERT'
      this.focus = 'composer'
      if (key === 'a') this.draft.move(1)
      return
    }
    if (key === 'n') {
      this.perform(() => this.execute('new'))
      return
    }
    if (key === 'r') {
      this.toggleTranscriptMode()
      return
    }
    if (key === 'N') {
      this.find(this.search)
      return
    }
    if (key === 'g') {
      if (this.prefix === 'g') {
        if (this.focus === 'detail') this.detailScroll = 0
        else this.scroll = this.contentRows.length
        this.draft.cursor = 0
        this.prefix = ''
      } else this.prefix = 'g'
      return
    }
    if (key === 'G') {
      if (this.focus === 'detail')
        this.detailScroll = Math.max(0, Math.max(this.detailRows.length, this.contentRows.length) - this.chatHeight)
      else this.scroll = 0
      this.draft.cursor = this.draft.text.length
      return
    }
    if (key === 'CTRL_D' || key === 'PAGE_DOWN') {
      if (this.focus === 'detail') this.detailScroll += Math.floor(this.chatHeight / 2)
      else this.scroll = Math.max(0, this.scroll - Math.floor(this.chatHeight / 2))
      return
    }
    if (key === 'CTRL_U' || key === 'PAGE_UP') {
      if (this.focus === 'detail') this.detailScroll = Math.max(0, this.detailScroll - Math.floor(this.chatHeight / 2))
      else this.scroll += Math.floor(this.chatHeight / 2)
      return
    }
    if (this.focus === 'sessions') {
      if (key === 'j' || key === 'DOWN') this.moveSidebar(1)
      else if (key === 'k' || key === 'UP') this.moveSidebar(-1)
      else if (key === 'h' || key === 'LEFT') this.collapseSidebarRow()
      else if (key === 'l' || key === 'RIGHT') this.expandSidebarRow()
      else if (key === 'ENTER') this.activateSidebarRow()
    } else if (this.focus === 'composer') {
      if (key === 'h' || key === 'LEFT') this.draft.move(-1)
      else if (key === 'l' || key === 'RIGHT') this.draft.move(1)
      else if (key === 'j' || key === 'DOWN') this.draft.vertical(1)
      else if (key === 'k' || key === 'UP') this.draft.vertical(-1)
      else if (['w', 'b', '0', '$', 'HOME', 'END'].includes(key)) this.draft.motion(key)
      else if (key === 'x') this.draft.delete(false)
      else if (key === 'u') this.draft.undo()
      else if (key === 'CTRL_R') this.draft.undo(true)
      else if (key === 'v') this.draft.anchor = this.draft.anchor === undefined ? this.draft.cursor : undefined
      else if (key === 'y' || key === 'd') this.draft.yank(key === 'd')
      else if (key === 'p') this.draft.paste()
    } else if (this.focus === 'detail') {
      if (key === 'j' || key === 'DOWN') this.detailScroll++
      if (key === 'k' || key === 'UP') this.detailScroll = Math.max(0, this.detailScroll - 1)
    } else {
      if (key === 'd') this.toggleVisibleChanges()
      else if (key === 'j' || key === 'DOWN') this.scroll = Math.max(0, this.scroll - 1)
      else if (key === 'k' || key === 'UP') this.scroll++
    }
  }

  private edit(editor: DraftEditor, key: string, data: { isCharacter?: boolean }): void {
    if (key === 'BACKSPACE') editor.delete(true)
    else if (key === 'DELETE') editor.delete(false)
    else if (key === 'LEFT') editor.move(-1)
    else if (key === 'RIGHT') editor.move(1)
    else if (key === 'UP') editor.vertical(-1)
    else if (key === 'DOWN') editor.vertical(1)
    else if (key === 'HOME' || key === 'END') editor.motion(key)
    else if (key === 'CTRL_Z') editor.undo()
    else if (key === 'CTRL_R') editor.undo(true)
    else if (key === 'CTRL_J' || key === 'SHIFT_ENTER') editor.insert('\n')
    else if (data.isCharacter || key.length === 1) editor.insert(key)
  }

  private readonly onMouse = (name: string, data: { x: number; y: number }): void => {
    if (this.interaction) {
      if (name === 'MOUSE_LEFT_BUTTON_PRESSED') {
        const height = this.screen?.height ?? 0
        const optionRows = Math.max(1, height - Math.floor(height / 2) - 6)
        const index = Math.max(0, this.interactionIndex - optionRows + 1) + data.y - Math.floor(height / 2) - 2
        const option = this.interaction.options[index]
        if (option) this.interaction.answer(option)
      }
      this.invalidate()
      return
    }
    if (this.form || this.showHelp) return
    if (this.mode === 'TERMINAL') {
      const button = name === 'MOUSE_WHEEL_UP' ? 64 : name === 'MOUSE_WHEEL_DOWN' ? 65 : 0
      if (
        name === 'MOUSE_LEFT_BUTTON_PRESSED' ||
        name === 'MOUSE_LEFT_BUTTON_RELEASED' ||
        name.startsWith('MOUSE_WHEEL')
      ) {
        this.terminal?.view.write(
          `\x1b[<${button};${Math.max(1, data.x - 1)};${Math.max(1, data.y - 3)}${name.endsWith('RELEASED') ? 'm' : 'M'}`,
        )
      }
      return
    }
    if (name === 'MOUSE_LEFT_BUTTON_PRESSED') {
      if (this.menu) {
        this.menu.index = Math.max(0, this.menu.index - ((this.screen?.height ?? 0) - 9)) + Math.max(0, data.y - 6)
        this.handleKey('ENTER', {})
        this.invalidate()
        return
      }
      if (Math.abs(data.x - this.sideWidth) <= 1 && this.sideWidth) this.dragging = true
      else if (data.x < this.sideWidth && this.sideWidth) {
        this.focus = 'sessions'
        const rows = this.navigationRows()
        if (rows.length === 0) return
        const top = Math.max(0, this.sidebarIndex - ((this.screen?.height ?? 0) - 6))
        const index = top + data.y - 3
        const row = rows[index]
        if (!row) return
        this.sidebarIndex = index
        this.sidebarKey = row.key
        if (row.kind === 'workspace') this.toggleWorkspace(row.workspaceId)
        else this.perform(() => this.select(row.sessionId))
      } else if (data.y > this.composerY) {
        this.focus = 'composer'
        this.mode = 'INSERT'
      } else {
        this.focus = 'chat'
        const contentRow = Math.max(0, this.contentRows.length - this.chatHeight - this.scroll) + data.y - 3
        const tool = this.toolContentRows.get(contentRow)
        if (tool !== undefined) {
          this.pendingToolAnchor = { key: tool, viewportRow: Math.max(0, data.y - 3) }
          this.toggleTool(tool)
          this.invalidate()
          return
        }
        const changes = this.changeContentRows.get(contentRow)
        if (changes !== undefined) {
          this.pendingChangeAnchor = { key: changes, viewportRow: Math.max(0, data.y - 3) }
          this.toggleChanges(changes)
          this.invalidate()
          return
        }
        this.selectionStart = contentRow
      }
    } else if (name === 'MOUSE_DRAG') {
      if (this.dragging) this.sidebarWidth = Math.max(18, Math.min(50, data.x))
      else if (this.selectionStart !== undefined) {
        const end = Math.max(0, this.contentRows.length - this.chatHeight - this.scroll) + data.y - 3
        this.selectedText = this.contentRows
          .slice(Math.min(this.selectionStart, end), Math.max(this.selectionStart, end) + 1)
          .join('\n')
        this.model.message = t('charactersSelectedCopy', [this.selectedText.length])
      }
    } else if (name === 'MOUSE_LEFT_BUTTON_RELEASED') {
      this.dragging = false
      this.selectionStart = undefined
    } else if (name === 'MOUSE_WHEEL_UP') this.scroll += 3
    else if (name === 'MOUSE_WHEEL_DOWN') this.scroll = Math.max(0, this.scroll - 3)
    this.invalidate()
  }

  private cycleFocus(direction: number): void {
    const seats: Focus[] = this.sideWidth
      ? ['sessions', 'chat', 'composer', ...(this.showDetail ? ['detail' as const] : [])]
      : ['chat', 'composer']
    this.focus = seats[(seats.indexOf(this.focus) + direction + seats.length) % seats.length] ?? 'composer'
  }

  private navigationRows(): SidebarRow[] {
    const workspaces = this.model.ctx.workspaces.list.getSnapshot()
    let rows = sidebarRows(
      workspaces.items,
      workspaces.archivedSessionIds,
      this.model.ctx.sessions.list.getSnapshot(),
      this.expandedWorkspaces,
    )
    if (this.pendingRevealSession !== undefined) {
      const workspace = workspaceForSession(workspaces.items, this.pendingRevealSession)
      if (workspace !== undefined) {
        this.expandedWorkspaces.add(workspace.workspaceId)
        rows = sidebarRows(
          workspaces.items,
          workspaces.archivedSessionIds,
          this.model.ctx.sessions.list.getSnapshot(),
          this.expandedWorkspaces,
        )
        const reveal = rows.findIndex(row => row.kind === 'session' && row.sessionId === this.pendingRevealSession)
        if (reveal >= 0) {
          this.sidebarIndex = reveal
          this.sidebarKey = rows[reveal]?.key
          this.pendingRevealSession = undefined
        }
      }
    }
    const stable = this.sidebarKey === undefined ? -1 : rows.findIndex(row => row.key === this.sidebarKey)
    if (stable >= 0) this.sidebarIndex = stable
    else this.sidebarIndex = Math.max(0, Math.min(this.sidebarIndex, rows.length - 1))
    this.sidebarKey = rows[this.sidebarIndex]?.key
    return rows
  }

  private moveSidebar(direction: number): void {
    const rows = this.navigationRows()
    this.sidebarIndex = Math.max(0, Math.min(rows.length - 1, this.sidebarIndex + direction))
    this.sidebarKey = rows[this.sidebarIndex]?.key
  }

  private activateSidebarRow(): void {
    const row = this.navigationRows()[this.sidebarIndex]
    if (row?.kind === 'workspace') this.toggleWorkspace(row.workspaceId)
    else if (row) this.perform(() => this.select(row.sessionId))
  }

  private collapseSidebarRow(): void {
    const row = this.navigationRows()[this.sidebarIndex]
    if (!row) return
    const workspaceId = row.workspaceId
    if (row.kind === 'session') this.sidebarKey = `workspace:${workspaceId}`
    else this.expandedWorkspaces.delete(workspaceId)
    this.navigationRows()
  }

  private expandSidebarRow(): void {
    const row = this.navigationRows()[this.sidebarIndex]
    if (row?.kind === 'workspace') this.expandedWorkspaces.add(row.workspaceId)
  }

  private toggleWorkspace(workspaceId: WorkspaceId): void {
    if (this.expandedWorkspaces.has(workspaceId)) this.expandedWorkspaces.delete(workspaceId)
    else this.expandedWorkspaces.add(workspaceId)
    this.sidebarKey = `workspace:${workspaceId}`
  }

  private toggleTranscriptMode(): void {
    this.transcriptMode = this.transcriptMode === 'clean' ? 'raw' : 'clean'
    this.model.message = t('transcriptModeChanged', [this.transcriptMode])
    this.scroll = 0
  }

  private toggleTool(key: string): void {
    if (this.expandedTools.has(key)) this.expandedTools.delete(key)
    else this.expandedTools.add(key)
    this.toolExpansionRevision++
  }

  private toggleChanges(key: string): void {
    if (this.expandedChanges.has(key)) this.expandedChanges.delete(key)
    else {
      this.expandedChanges.add(key)
      const summary = this.changeSummaries.get(key)
      if (typeof summary !== 'string' && summary !== undefined) this.loadChangesDiffs(key, summary.files.length)
    }
    this.changesRevision++
  }

  private toggleVisibleChanges(): void {
    const start = Math.max(0, this.contentRows.length - this.chatHeight - this.scroll)
    const entries = [...this.changeContentRows]
    const target = entries.find(([row]) => row >= start && row < start + this.chatHeight) ?? entries.at(-1)
    if (target === undefined) return
    const [row, key] = target
    this.pendingChangeAnchor = { key, viewportRow: Math.max(0, row - start) }
    this.toggleChanges(key)
  }

  private async select(id: SessionId): Promise<void> {
    this.persistDraft()
    this.detachTerminal()
    await this.model.select(id)
    this.expandedTools.clear()
    this.expandedChanges.clear()
    this.toolExpansionRevision++
    this.changesRevision++
    this.draft.reset(this.model.drafts.get(id) ?? '')
    this.scroll = 0
  }

  private async send(steer: boolean): Promise<void> {
    const text = this.draft.text,
      id = this.model.binding?.sessionId
    await this.model.send(text, this.model.deliveryMode(steer))
    if (this.model.binding?.sessionId === id && this.draft.text === text) this.draft.reset()
    this.scroll = 0
  }

  private perform(operation: () => void | Promise<void>): void {
    void Promise.resolve()
      .then(operation)
      .catch((error: unknown) => {
        this.model.message = error instanceof Error ? error.message : String(error)
      })
      .finally(() => {
        this.invalidate()
      })
  }

  private dismiss(): void {
    this.menu = undefined
    this.form = undefined
    this.command = undefined
    this.showHelp = false
    this.input.reset()
  }

  private palette(prefix = ''): void {
    const actions = [...this.model.actions.values()].filter(action => !prefix || action.id.startsWith(prefix))
    const methods = this.model
      .methods()
      .filter(method => !prefix || method.namespace.toLowerCase().includes(prefix.toLowerCase()))
    this.menu = {
      title: prefix ? t('actions', [prefix.toUpperCase()]) : t('commandPALETTE'),
      index: 0,
      items: [
        ...actions.map(action => ({ label: action.label, detail: action.description, run: () => action.run() })),
        ...methods.map(method => ({
          label: `${method.namespace} · ${humanize(method.method)}`,
          detail: method.description?.split('\n')[0],
          run: () => {
            this.methodForm(method)
          },
        })),
      ],
    }
    this.input.reset()
  }

  private methodForm(method: InvocationDescriptor): void {
    const id = this.model.binding?.sessionId
    const fields: FormField[] = method.parameters.map((parameter) => {
      const schema = parameter.codec.mode === 'strict' ? parameter.codec.jsonSchema : undefined
      const isString = schema?.type === 'string' || parameter.source === 'lookup'
      return {
        key: parameter.wire,
        label: humanize(parameter.name),
        value: parameter.source === 'lookup' && id ? id : '',
        optional: parameter.acceptsUndefined === true,
        json: !isString,
        secret: method.namespace === 'credentials' && method.method === 'set' && parameter.name === 'value',
      }
    })
    const run = async (values: Record<string, unknown>): Promise<void> => {
      this.showDetail = true
      this.focus = 'detail'
      this.detailScroll = 0
      await this.model.invoke(method, values)
    }
    if (fields.length === 0) {
      this.perform(() => run({}))
      return
    }
    this.form = {
      title: `${method.namespace} · ${humanize(method.method)}`,
      detail: method.description ?? '',
      fields,
      index: 0,
      run,
    }
    this.input.reset(fields[0]?.value ?? '')
  }

  private submitForm(): void {
    const form = this.form
    if (!form) return
    const activeField = form.fields[form.index]
    if (!activeField) return
    activeField.value = this.input.text
    try {
      const values: Record<string, unknown> = {}
      for (const field of form.fields) {
        if (field.optional && field.value === '') continue
        values[field.key] = field.json ? JSON.parse(field.value) : field.value
      }
      this.form = undefined
      this.input.reset()
      this.perform(() => form.run(values))
    } catch (error) {
      this.model.message = error instanceof Error ? error.message : String(error)
    }
  }

  private prompt(title: string, run: (value: string) => void | Promise<void>, value = ''): void {
    this.form = {
      title,
      detail: '',
      index: 0,
      fields: [{ key: 'value', label: title, value, optional: false, json: false }],
      run: values => run(String(values.value)),
    }
    this.input.reset(value)
  }

  private installActions(): void {
    const entries: Array<[string, string, string]> = [
      ['new', t('newSession'), t('createASharedHarnessSession')],
      ['sessions', t('switchSession'), ''],
      ['workspaces', t('workspaces'), ''],
      ['stop', t('stopCurrentTurn'), t('queuedMessagesRemain')],
      ['fork', t('forkSession'), ''],
      ['older', t('loadOlderMessages'), ''],
      ['rename', t('renameSession'), ''],
      ['files', t('files'), t('browseWorkspaceFiles')],
      ['settings', t('settings'), ''],
      ['models', t('models'), ''],
      ['plugins', t('plugins'), t('inventoryConfigurationInstallAndMarketplace')],
      ['goals', t('goals'), ''],
      ['schedules', t('schedules'), ''],
      ['questions', t('pendingQuestions'), t('answerAContinuedAgentQuestion')],
      ['jobs', t('jobs'), ''],
      ['subagents', t('subagents'), ''],
      ['commands', t('harnessCommands'), ''],
      ['terminal', t('newTerminal'), ''],
      ['terminals', t('sharedTerminals'), ''],
      ['attach', t('attachAFile'), ''],
      ['image', t('attachAnImage'), ''],
      ['export', t('exportConversation'), ''],
      ['inspect', t('inspectSession'), ''],
      ['raw', t('toggleRawTranscript'), t('switchCleanAndRawTranscriptOutput')],
      ['help', t('keyboardHelp'), ''],
      ['reconnect', 'Reconnect', ''],
    ]
    for (const [id, label, description] of entries)
      this.actionDisposers.push(
        this.model.registerAction({ id, label, description, run: () => this.execute(id) } satisfies TuiAction),
      )
  }

  private async execute(line: string): Promise<void> {
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(line.trim())
    const command = match?.[1] ?? 'palette',
      arg = match?.[2] ?? ''
    const session = this.model.binding?.session
    switch (command) {
      case 'q':
      case 'quit':
        this.close()
        return
      case 'help':
        this.showHelp = true
        return
      case 'palette':
      case 'actions':
        this.palette()
        return
      case 'new': {
        if (!arg) {
          this.newSessionMenu()
          return
        }
        await this.select(await this.model.ctx.sessions.create({ cwd: arg }))
        return
      }
      case 'raw':
        this.toggleTranscriptMode()
        return
      case 'questions': {
        this.menu = {
          title: t('pendingQuestionsTitle'),
          index: 0,
          items: this.model.pendingQuestions().map(question => ({
            label: question.questions.map(item => item.header ?? item.question).join(' · '),
            run: () => this.model.answerPending(question),
          })),
        }
        this.input.reset()
        return
      }
      case 'sessions': {
        const list = this.model.ctx.sessions.list.getSnapshot()
        this.menu = {
          title: t('sessions'),
          index: 0,
          items: list.ids.map(id => ({
            label: list.byId[id]?.displayTitle ?? id,
            detail: id,
            run: () => this.select(id),
          })),
        }
        this.input.reset()
        return
      }
      case 'rename':
        if (!session) throw new Error(t('selectASessionFirst'))
        if (!arg) {
          this.prompt(t('sessionTitle'), value => this.execute(t('rename', [value])))
          return
        }
        {
          const result = await session.rename(arg)
          if (!result.ok) throw new Error(result.error.message)
        }
        return
      case 'fork':
        if (!this.model.binding) throw new Error(t('selectASessionFirst'))
        await this.select(
          await this.model.ctx.sessions.fork({ sessionId: this.model.binding.sessionId, increaseTitle: true }),
        )
        return
      case 'older':
        await session?.loadOlder()
        return
      case 'stop': {
        const result = await session?.cancel()
        if (result && !result.ok) throw new Error(result.error.message)
        return
      }
      case 'reconnect':
        this.model.connection.reconnect()
        return
      case 'inspect':
        this.model.result = pretty({
          session: session?.getSnapshot(),
          projections: this.model.binding
            ? this.model.ctx.sessions.list.getSnapshot().byId[this.model.binding.sessionId]
            : undefined,
          chat: this.model.chat()?.legacy,
        })
        this.showDetail = true
        return
      case 'result':
        this.showDetail = !this.showDetail
        this.focus = this.showDetail ? 'detail' : 'chat'
        return
      case 'search':
        if (!arg) {
          this.prompt(t('searchSessions'), value => this.execute(t('search', [value])))
          return
        }
        {
          const result = await this.model.ctx.sessions.search(arg, new AbortController().signal)
          this.model.result = pretty(result)
          this.showDetail = true
        }
        return
      case 'copy':
        this.term(`\x1b]52;c;${Buffer.from(this.selectedText).toString('base64')}\x07`)
        return
      case 'mouse':
        this.options.mouse = !this.options.mouse
        this.term.grabInput({ mouse: this.options.mouse ? 'drag' : undefined })
        return
      case 'clearattachments':
        if (this.model.binding) this.model.attachments.delete(this.model.binding.sessionId)
        return
      case 'attach':
      case 'image':
        if (!arg) {
          this.prompt(t('localFilePath'), value => this.execute(`${command} ${value}`))
          return
        }
        await this.attach(arg, command === 'image')
        return
      case 'transcript':
        if (!arg) {
          this.prompt(t('exportPathOnThisMachine'), value => this.execute(t('export', [value])))
          return
        }
        await writeFile(arg, transcript(this.model.chat(), this.model.renderers, this.transcriptMode).join('\n'), {
          flag: 'wx',
          mode: 0o600,
        })
        this.model.message = t('exportedLoadedConversationTo', [arg])
        return
      case 'export': {
        if (!this.model.binding) throw new Error(t('selectASessionFirst'))
        if (!arg) {
          this.prompt(t('sessionArchiveOutputPathZip'), value => this.execute(t('export', [value])))
          return
        }
        const route = `api/session.export?sessionId=${encodeURIComponent(this.model.binding.sessionId)}`
        const response = await this.model.transport.fetch(route)
        if (!response.ok) throw new Error(t('exportFailedHTTP', [response.status]))
        await writeFile(arg, new Uint8Array(await response.arrayBuffer()), { flag: 'wx', mode: 0o600 })
        this.model.message = t('exportedCompleteSessionArchiveTo', [arg])
        return
      }
      case 'files':
        await this.files(arg || '.')
        return
      case 'terminals': {
        if (!this.model.binding) throw new Error(t('selectASessionFirst'))
        const result = await this.model.ctx.remote.terminal.list(this.model.binding.sessionId)
        if (!result.ok) throw new Error(result.error.message)
        this.menu = {
          title: t('sharedTERMINALS'),
          index: 0,
          items: [
            { label: t('newTerminal'), run: () => this.openTerminal('') },
            ...result.value.map(item => ({
              label: `${item.title} · ${item.state}`,
              detail: item.id,
              run: () => this.openTerminal(item.id),
            })),
          ],
        }
        this.input.reset()
        return
      }
      case 'download': {
        if (!arg) {
          this.prompt(t('harnessRouteAndLocalOutputPath'), value => this.execute(t('download', [value])))
          return
        }
        const separator = arg.indexOf(' ')
        if (separator < 0) throw new Error(t('useDownloadROUTEOUTPUTPATH'))
        const response = await this.model.transport.fetch(arg.slice(0, separator))
        if (!response.ok) throw new Error(t('downloadFailedHTTP', [response.status]))
        await writeFile(arg.slice(separator + 1), new Uint8Array(await response.arrayBuffer()), {
          flag: 'wx',
          mode: 0o600,
        })
        return
      }
      case 'open':
        if (!arg) {
          this.prompt(t('urlToOpenExternally'), value => this.execute(t('open', [value])))
          return
        }
        {
          const url = new URL(arg)
          if (!['http:', 'https:', 'file:'].includes(url.protocol)) throw new Error(t('useAnHTTPOrFileURL'))
          const child = spawn('xdg-open', [url.href], { stdio: 'ignore', detached: true })
          child.on('error', (error) => {
            this.model.message = error.message
            this.invalidate()
          })
          child.unref()
        }
        return
      case 'terminal':
        await this.openTerminal(arg)
        return
      case 'terminalinput':
        if (this.terminal) this.mode = 'TERMINAL'
        return
      case 'termdetach':
        this.detachTerminal()
        return
      case 'termclose':
        await this.terminal?.view.close()
        this.detachTerminal()
        return
      case 'cancelobservation':
        this.model.cancelObservation()
        return
      default: {
        const namespaces: Record<string, string> = {
          files: 'workspaceFiles',
          workspaces: 'workspace',
          models: 'llm',
          plugins: 'plugin',
          goals: 'goal',
          schedules: 'schedule',
          jobs: 'job',
          subagents: 'subagents',
          commands: 'commands',
          terminals: 'terminal',
          settings: 'settings',
        }
        const namespace = namespaces[command]
        if (namespace) {
          this.palette(namespace)
          return
        }
        const action = this.model.actions.get(command)
        if (action) {
          await action.run()
          return
        }
        throw new Error(t('unknownTUICommandUsePaletteOr', [command]))
      }
    }
  }

  private newSessionMenu(): void {
    const workspaces = this.model.ctx.workspaces.list.getSnapshot().items
    this.menu = {
      title: t('chooseAWorkspace'),
      index: 0,
      emptyMessage: t('noWorkspacesCreateOneWithWorkspaces'),
      items: workspaces.map(workspace => ({
        label: workspace.title,
        detail: workspace.path,
        run: async () => {
          this.expandedWorkspaces.add(workspace.workspaceId)
          const sessionId = await this.model.ctx.sessions.create({ workspaceId: workspace.workspaceId })
          this.pendingRevealSession = sessionId
          await this.select(sessionId)
        },
      })),
    }
    this.input.reset()
  }

  private async attach(path: string, image: boolean): Promise<void> {
    const binding = this.model.binding
    if (!binding) throw new Error(t('selectASessionFirst'))
    const bytes = await readFile(path)
    const parts = this.model.attachments.get(binding.sessionId) ?? []
    if (image) {
      const extension = path.split('.').at(-1)?.toLowerCase()
      const mediaType =
        extension === 'png'
          ? 'image/png'
          : extension === 'jpg' || extension === 'jpeg'
            ? 'image/jpeg'
            : extension === 'gif'
              ? 'image/gif'
              : extension === 'webp'
                ? 'image/webp'
                : undefined
      if (!mediaType) throw new Error(t('supportedImagesPNGJPEGGIFWebP'))
      parts.push({ type: 'image', mediaType, data: bytes.toString('base64'), name: basename(path) })
    } else {
      const result = await this.model.ctx.fileUpload.upload(binding.sessionId, bytes, basename(path))
      if (!result.ok) throw new Error(result.error.message)
      parts.push({ type: 'file', receiptId: result.value.receiptId })
    }
    this.model.attachments.set(binding.sessionId, parts)
    this.model.message = t('attached', [basename(path)])
  }

  private async files(path: string): Promise<void> {
    const id = this.model.binding?.sessionId
    if (!id) throw new Error(t('selectASessionFirst'))
    const listing = await this.model.ctx.remote.workspaceFiles.list(id, path)
    if (!listing.ok) throw new Error(listing.error.message)
    this.menu = {
      title: t('files2', [path]),
      index: 0,
      items: [
        { label: t('parent'), run: () => this.files(path.replace(/\/?[^/]+\/?$/, '') || '.') },
        ...listing.value.entries.map((entry) => {
          const target = path.replace(/\/$/, '') + '/' + entry.name
          return {
            label: `${entry.type === 'directory' ? '▸ ' : '  '}${entry.name}`,
            detail: entry.type,
            run: async () => {
              if (entry.type === 'directory') {
                await this.files(target)
                return
              }
              this.menu = {
                title: entry.name,
                index: 0,
                items: [
                  {
                    label: t('previewText'),
                    run: async () => {
                      const result = await this.model.ctx.remote.workspaceFiles.read(id, target, {})
                      if (!result.ok) throw new Error(result.error.message)
                      this.model.result = `${result.value.absolutePath}\n\n${result.value.text}${result.value.eof ? '' : t('moreLinesAvailableThroughFilesActions')}`
                      this.showDetail = true
                      this.focus = 'detail'
                    },
                  },
                  {
                    label: t('downloadFile'),
                    run: () => {
                      this.prompt(t('localOutputPath'), output => this.downloadFile(id, target, output))
                    },
                  },
                ],
              }
              this.input.reset()
            },
          }
        }),
        {
          label: t('moreFileActionsRangesBytesWatches'),
          run: () => {
            this.palette('workspaceFiles')
          },
        },
      ],
    }
    this.input.reset()
  }

  private downloadFile(id: SessionId, path: string, output: string): Promise<void> {
    const operation = this.saveFile(id, path, output).finally(() => {
      this.downloads.delete(operation)
    })
    this.downloads.add(operation)
    return operation
  }

  private async saveFile(id: SessionId, path: string, output: string): Promise<void> {
    const temporary = `${output}.dsh-${randomUUID()}`
    const file = await open(temporary, 'wx', 0o600)
    let offset = 0
    let version: string | undefined
    try {
      while (true) {
        const result = await this.model.ctx.remote.workspaceFiles.readBytes(
          id,
          path,
          { range: { offset } },
          this.lifetime.signal,
        )
        if (!result.ok) throw new Error(result.error.message)
        const page = result.value
        if (version !== undefined && version !== page.version) throw new Error(t('fileChangedDuringDownload'))
        version = page.version
        await file.writeFile(page.data)
        if (page.eof) break
        if (page.data.byteLength === 0) throw new Error(t('fileDownloadStoppedMakingProgress'))
        offset += page.data.byteLength
      }
      await link(temporary, output)
      this.model.message = t('savedFileTo', [output])
    } finally {
      await file.close()
      await unlink(temporary)
    }
  }

  private find(query: string): void {
    this.search = query
    if (!query) return
    const before = Math.max(0, this.contentRows.length - this.scroll - 1)
    const index = this.contentRows.findLastIndex((row, i) => i < before && row.includes(query))
    if (index >= 0) this.scroll = Math.max(0, this.contentRows.length - this.chatHeight - index)
  }

  private async openTerminal(id: string): Promise<void> {
    const sessionId = this.model.binding?.sessionId
    if (!sessionId) throw new Error(t('selectASessionFirst'))
    this.detachTerminal()
    const contentId = randomUUID()
    const found = id ? await this.model.ctx.remote.terminal.list(sessionId) : undefined
    if (found && !found.ok) throw new Error(found.error.message)
    const existing = found?.ok ? found.value.find(item => item.id === id) : undefined
    if (id && !existing) throw new Error(t('unknownTerminalUseTerminalsToListExisting'))
    const view = this.model.ctx.webTerminals.view(sessionId, contentId, contentId, existing?.id)
    this.terminalTabs.push({ sessionId, tabId: contentId, contentId })
    this.model.ctx.webTerminals.retainTabs(this.terminalTabs)
    const emulator = new xterm.Terminal({
      cols: Math.max(2, this.term.width - 2),
      rows: Math.max(2, this.term.height - 4),
      allowProposedApi: true,
    })
    const stop = view.mount()
    const unsubscribe = view.state.subscribe(() => {
      const state = view.state.getSnapshot()
      const frame = state.render
      if (frame && this.terminal && frame.revision !== this.terminal.revision) {
        this.terminal.revision = frame.revision
        if (frame.frame.type === 'snapshot') emulator.reset()
        emulator.write(frame.frame.type === 'snapshot' ? frame.frame.screen : frame.frame.data, () => {
          view.acknowledge(frame.revision)
          this.invalidate()
        })
      }
      if (state.error) this.model.message = state.error
      this.invalidate()
    })
    this.terminal = { view, emulator, stop, unsubscribe, revision: -1 }
    view.resize(emulator.cols, emulator.rows)
    this.mode = 'TERMINAL'
  }

  private renderTerminal(width: number, height: number): void {
    if (!this.terminal) return
    this.box(
      t('terminalCtrlReturnsTermdetachHides', [this.terminal.view.state.getSnapshot().title ?? '']),
      width,
      height,
    )
    const buffer = this.terminal.emulator.buffer.active
    for (let y = 0; y < height - 5; y++)
      this.line(1, y + 3, buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '', width - 2)
  }

  private detachTerminal(): void {
    if (!this.terminal) return
    this.terminal.unsubscribe()
    this.terminal.stop()
    this.terminal.emulator.dispose()
    this.terminal = undefined
    this.mode = 'NORMAL'
  }

  private readonly onStdin = (bytes: Buffer): void => {
    this.pasteDecoder?.push(bytes)
  }

  private installPaste(): void {
    // Terminal Kit 3's key decoder does not implement bracketed paste. Keep its
    // parser for ordinary keys and intercept only the standard paste frames.
    const handler: unknown = Reflect.get(this.term, 'onStdin')
    if (typeof handler !== 'function') throw new Error(t('terminalKitInputDecoderIsUnavailable'))
    process.stdin.removeListener('data', handler as (bytes: Buffer) => void)
    this.keyHandler = (bytes) => {
      // Terminal Kit maps control letters but omits FS (Ctrl-Backslash).
      // Decode it here, outside bracketed paste, so terminal escape always works.
      let start = 0
      for (let index = 0; index < bytes.length; index++) {
        if (bytes[index] !== 0x1c) continue
        if (index > start) Reflect.apply(handler, this.term, [bytes.subarray(start, index)])
        this.onKey('CTRL_BACKSLASH', undefined)
        start = index + 1
      }
      if (start < bytes.length) Reflect.apply(handler, this.term, [bytes.subarray(start)])
    }
    this.pasteDecoder = new PasteDecoder(
      this.keyHandler,
      (text) => {
        if (this.mode === 'TERMINAL') this.terminal?.view.write(text)
        else {
          this.editor().insert(text)
          this.persistDraft()
          this.invalidate()
        }
      },
      this.options.escapeDelayMs,
    )
    process.stdin.on('data', this.onStdin)
  }

  private releaseTerminal(): void {
    process.stdin.off('data', this.onStdin)
    this.pasteDecoder?.dispose()
    this.pasteDecoder = undefined
    this.term('\x1b[?2004l')
    this.term.grabInput(false)
    this.term.hideCursor(false)
    this.term.styleReset()
    this.term.fullscreen(false)
  }

  private restore(): void {
    this.closed = true
    this.lifetime.abort()
    this.model.cancelObservation()
    if (this.frame) clearTimeout(this.frame)
    if (this.activityFrame) clearTimeout(this.activityFrame)
    this.detachTerminal()
    this.model.changed.delete(this.invalidate)
    for (const dispose of this.actionDisposers) dispose()
    this.term.off('key', this.onKey)
    this.term.off('mouse', this.onMouse)
    this.term.off('resize', this.onResize)
    this.term.off('terminal', this.onTerminal)
    process.off('SIGINT', this.onExit)
    process.off('SIGTERM', this.onExit)
    process.off('SIGTSTP', this.onSuspend)
    process.off('SIGCONT', this.onResume)
    this.releaseTerminal()
  }
}

function humanize(text: string): string {
  return text.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ')
}
function sameRendererEntries(
  left: ReadonlyArray<readonly [string, TranscriptRenderer]>,
  right: ReadonlyArray<readonly [string, TranscriptRenderer]>,
): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right.at(index)
    return other !== undefined && entry[0] === other[0] && entry[1] === other[1]
  })
}
function terminalKey(key: string): string {
  const keys: Record<string, string> = {
    ENTER: '\r',
    TAB: '\t',
    BACKSPACE: '\x7f',
    UP: '\x1b[A',
    DOWN: '\x1b[B',
    RIGHT: '\x1b[C',
    LEFT: '\x1b[D',
    ESCAPE: '\x1b',
    CTRL_C: '\x03',
    CTRL_D: '\x04',
  }
  return keys[key] ?? ''
}
