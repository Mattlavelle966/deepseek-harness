/** Attach-only Cordis application plugin launched through the shipped tui profile. */
import { t } from './copy.ts'

import type { Context } from '@deepseek-ai/cordis'
import { Command } from 'commander'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import z from '@deepseek-ai/schemastery'
import { ApiTransport, resolveServer } from './transport.ts'
import { TuiModel } from './model.ts'
import { TuiView } from './view.ts'

export type { TuiAction } from './model.ts'
export { TuiModel } from './model.ts'
export { ApiTransport, resolveServer } from './transport.ts'
export { transcript } from './presenter.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-frontend'
/** The profile supplies command-line and bounded application exit services. */
export const inject = ['cmdlineArgs', 'appExit', 'appReady']

/** Presentation and connection limits configurable through profile overlays. */
export interface Config {
  escapeDelayMs: number
  maxStreamCharacters: number
  frameMs: number
  connectTimeoutMs: number
  mouse: boolean
}
/** Validated profile defaults; the backend stack has no TUI-specific configuration. */
export const Config: z<Config> = z.object({
  escapeDelayMs: z.natural().min(1).default(25),
  maxStreamCharacters: z.natural().min(1024).default(200000),
  frameMs: z.natural().min(1).default(33),
  connectTimeoutMs: z.natural().min(1).default(15000),
  mouse: z.boolean().default(true),
})

/**
 * Parse this profile's options, then attach after the launcher commits readiness.
 * @param ctx - profile-owned Cordis context.
 * @param config - validated screen and connection options.
 */
export function apply(ctx: Context, config: Config): void {
  const program = new Command()
    .name(t('dshTui'))
    .description(t('attachAKeyboardAndMouseTerminalFrontend'))
    .option('--url <url>', t('localhostHarnessURLOrDSHTUIURL'))
    .option('--session <id>', t('selectAnExistingSharedSession'))
    .option('--no-mouse', t('leaveMouseEventsToTmuxTerminalCopy'))
    .addHelpText('after', t('authenticationSetDSHTUITOKENToThe'))
  program.action(() => {
    const options = program.opts<{ url?: string; session?: string; mouse?: boolean }>()
    const input = options.url ?? process.env.DSH_TUI_URL
    if (!input) {
      program.error(t('errorSupplyUrlOrDSHTUIURL'))
      return
    }
    let base: URL
    try {
      base = resolveServer(input)
    } catch (error) {
      program.error(t('error', [error instanceof Error ? error.message : String(error)]))
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) program.error(t('errorTheTUIRequiresAnInteractiveTerminal'))
    const exit = ctx.get('appExit')
    const ready = ctx.get('appReady')
    if (!exit || !ready) throw new Error(t('theTuiProfileRequiresLauncherReadinessAnd'))
    const lifetime = new AbortController()
    let model: TuiModel | undefined
    let view: TuiView | undefined
    ctx.effect(
      () => async () => {
        lifetime.abort()
        view?.close()
        await model?.dispose()
      },
      t('tuiFrontendLifetime'),
    )
    ctx.effect(
      () =>
        ready.onReady(() => {
          void (async () => {
            try {
              lifetime.signal.throwIfAborted()
              model = new TuiModel(
                new ApiTransport(base, config.connectTimeoutMs), config.maxStreamCharacters,
              )
              await model.start()
              lifetime.signal.throwIfAborted()
              ctx.provide('tui', model)
              if (options.session) {
                const id = model.ctx.sessions.list.getSnapshot().ids.find(id => id === options.session)
                if (!id) throw new Error(t('theRequestedSessionIsNotInThis'))
                await model.select(id)
              }
              view = new TuiView(model, {
                mouse: options.mouse !== false && config.mouse,
                frameMs: config.frameMs,
                escapeDelayMs: config.escapeDelayMs,
              })
              await view.run()
              await model.dispose()
              model = undefined
              exit(0)
            } catch (error) {
              view?.close()
              await model?.dispose()
              model = undefined
              process.stderr.write(t('dshTui2', [error instanceof Error ? error.message : String(error)]))
              exit(1)
            }
          })()
        }),
      t('tuiStartAfterProfileReadiness'),
    )
  })
  parseCmdline(ctx, program)
}

