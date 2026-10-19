/** Authenticated Node carrier for the existing browser/API transport. */
import { t } from './copy.ts'

import WebSocket from 'ws'
import type { ClientTransportHooks } from '@deepseek-ai/dsh-client-connection/client'

/** Validated API origin and mount, without launch credentials.
 * @param input - user-supplied localhost URL.
 * @returns a normalized application mount. */
export function resolveServer(input: string): URL {
  const url = new URL(input)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(t('useAnHTTPHarnessURL'))
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error(t('useALocalhostHarnessURLOrAn'))
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error(t('supplyTheLaunchTokenSeparatelyWithDSH'))
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

/** Per-instance cookie exchange; cookies never enter browser storage or files. */
export class ApiTransport {
  private cookie = ''
  private socketGeneration = 0
  private readonly sockets = new Set<WebSocket>()
  private readonly lifetime = new AbortController()

  constructor(
    readonly base: URL,
    /** Deadline for HTTP exchange, socket handshake, and initial readiness. */
    readonly timeoutMs: number,
  ) {}

  /** Open a local TUI Peer without a launch token.
   * @returns the server-advertised stream destination. */
  async authenticate(): Promise<URL> {
    const credential = await this.exchange()
    this.cookie = credential.cookie
    return credential.target
  }

  private async exchange(signal?: AbortSignal): Promise<{ cookie: string; target: URL }> {
    const connect = new URL('connect', this.base)
    connect.searchParams.set('client', 'tui')
    connect.searchParams.set('interactions', 'answer')
    const headers = new Headers({ 'x-dsh-local-client': 'dsh-tui' })
    let response: Response
    try {
      response = await fetch(connect, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.any([
          this.lifetime.signal,
          AbortSignal.timeout(this.timeoutMs),
          ...(signal ? [signal] : []),
        ]),
      })
    } catch {
      throw new Error(t('cannotReachTheHarnessAtStartAn', [this.base.href]))
    }
    if (response.status !== 302) throw new Error(t('harnessAuthenticationFailedHTTPCheckTheLaunch', [response.status]))
    const cookies = response.headers
      .getSetCookie()
      .map(cookie => cookie.split(';', 1)[0])
      .filter(Boolean)
    const location = response.headers.get('location')
    if (cookies.length === 0 || location === null) throw new Error(t('theHarnessDidNotReturnAnAPI'))
    const target = new URL(location, this.base)
    if (target.origin !== this.base.origin) throw new Error(t('theHarnessReturnedAStreamDestinationOn'))
    return { cookie: cookies.join('; '), target }
  }

  /** Install hooks used by Connection for all unary and streamed Remote methods.
   * @returns instance-owned authenticated transport hooks. */
  hooks(): ClientTransportHooks {
    let initial = true
    return {
      streamBaseUrl: this.base.href,
      fetch: (input, init) => this.fetch(String(input), init),
      createWebSocket: (url) => {
        const generation = ++this.socketGeneration
        const first = initial
        initial = false
        const socket = new WebSocket(url, {
          handshakeTimeout: this.timeoutMs,
          finishRequest: (request) => {
            const attempt = new AbortController()
            request.once('close', () => {
              attempt.abort()
            })
            const ready = first ? Promise.resolve({ cookie: this.cookie }) : this.exchange(attempt.signal)
            void ready
              .then((credential) => {
                if (
                  this.lifetime.signal.aborted ||
                  generation !== this.socketGeneration ||
                  request.destroyed ||
                  request.writableEnded
                ) {
                  request.destroy()
                  return
                }
                this.cookie = credential.cookie
                request.setHeader('Cookie', credential.cookie)
                request.end()
              })
              .catch(() => {
                request.destroy(new Error(t('harnessAuthenticationFailedDuringReconnection')))
              })
          },
        })
        // ws may report a late handshake failure after the stream owner has detached.
        socket.on('error', () => {})
        this.sockets.add(socket)
        socket.once('close', () => this.sockets.delete(socket))
        return socket
      },
    }
  }

  /** Fetch an authenticated route beneath the selected application mount.
   * @param path - document-relative route within the configured mount.
   * @param init - request options without credentials.
   * @returns the authenticated response. */
  fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path.replace(/^\//, ''), this.base)
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname))
      throw new Error(t('refusingToSendCredentialsOutsideTheHarness'))
    const headers = new Headers(init.headers)
    headers.set('Cookie', this.cookie)
    return fetch(url, {
      ...init,
      headers,
      redirect: 'error',
      signal: AbortSignal.any([this.lifetime.signal, ...(init.signal ? [init.signal] : [])]),
    })
  }

  /** Dispose API sockets without sending any agent or terminal shutdown command. */
  dispose(): void {
    this.lifetime.abort()
    for (const ws of this.sockets) ws.terminate()
    this.sockets.clear()
    this.cookie = ''
  }
}
