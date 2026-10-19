/** Local TUI exchange stays tokenless; renewed sockets own independent Peers. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { expect, it, vi } from 'vitest'
import { ApiTransport } from '../src/transport.ts'

it('uses one cookie for HTTP and WebSocket and renews it before a replacement socket', async () => {
  const cookies: Array<string | undefined> = []
  let exchanges = 0
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost')
    if (url.pathname === '/mount/connect') {
      expect(url.searchParams.get('client')).toBe('tui')
      expect(url.searchParams.has('token')).toBe(false)
      expect(url.searchParams.get('interactions')).toBe('answer')
      exchanges++
      response.writeHead(302, { location: './api/remote.mux', 'set-cookie': `api=peer-${exchanges}; HttpOnly; Path=/` })
      response.end()
    } else {
      cookies.push(request.headers.cookie)
      expect(url.searchParams.has('token')).toBe(false)
      response.writeHead(200)
      response.end('ok')
    }
  })
  const sockets = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    cookies.push(request.headers.cookie)
    sockets.handleUpgrade(request, socket, head, (ws) => {
      ws.on('error', () => {})
      sockets.emit('connection', ws, request)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('No listener')
  const transport = new ApiTransport(new URL(`http://127.0.0.1:${address.port}/mount/`), 1000)
  try {
    await transport.authenticate()
    const hooks = transport.hooks()
    const open = async () => {
      const socket = hooks.createWebSocket!(`ws://127.0.0.1:${address.port}/mount/api/remote.mux`)
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => {
          resolve()
        })
        socket.addEventListener('error', () => {
          reject(new Error('Socket failed'))
        })
      })
      return socket
    }
    const first = await open()
    expect(await (await transport.fetch('api/probe')).text()).toBe('ok')
    first.close()
    const second = await open()
    await transport.fetch('api/probe')
    second.close()
    expect(exchanges).toBe(2)
    expect(cookies).toEqual(['api=peer-1', 'api=peer-1', 'api=peer-2', 'api=peer-2'])
    expect(() => transport.fetch('http://remote.example/')).toThrow('outside')
  } finally {
    transport.dispose()
    for (const socket of sockets.clients) socket.terminate()
    await new Promise<void>((resolve) => {
      sockets.close(() => {
        resolve()
      })
    })
    await new Promise<void>(resolve =>
      server.close(() => {
        resolve()
      }),
    )
  }
})

it('fails without starting a server when the existing instance is unavailable', async () => {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('No listener')
  const port = address.port
  await new Promise<void>(resolve =>
    server.close(() => {
      resolve()
    }),
  )
  const transport = new ApiTransport(new URL(`http://127.0.0.1:${port}/`), 1000)
  try {
    await expect(transport.authenticate()).rejects.toThrow('Cannot reach the harness')
  } finally {
    transport.dispose()
  }
})

it('aborts a superseded credential exchange before opening its replacement', async () => {
  let exchanges = 0
  let delayed: import('node:http').ServerResponse | undefined
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/connect')) {
      const peer = ++exchanges
      if (peer === 2) {
        delayed = response
        return
      }
      response.writeHead(302, { location: './api/remote.mux', 'set-cookie': `api=peer-${peer}; Path=/` })
      response.end()
    } else {
      response.end(request.headers.cookie)
    }
  })
  const sockets = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, (ws) => {
      ws.on('error', () => {})
      sockets.emit('connection', ws, request)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('No listener')
  const transport = new ApiTransport(new URL(`http://127.0.0.1:${address.port}/`), 10000)
  try {
    await transport.authenticate()
    const hooks = transport.hooks()
    const open = () => hooks.createWebSocket!(`ws://127.0.0.1:${address.port}/api/remote.mux`)
    const opened = (socket: ReturnType<typeof open>) =>
      new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () =>{  resolve() })
        socket.addEventListener('error', () =>{  reject(new Error('Socket failed')) })
      })
    const first = open()
    await opened(first)
    first.close()
    const superseded = open()
    await vi.waitFor(() =>{  expect(delayed).toBeDefined() })
    superseded.close()
    await vi.waitFor(() =>{  expect(delayed?.destroyed).toBe(true) })
    const replacement = open()
    await opened(replacement)
    expect(await (await transport.fetch('api/probe')).text()).toBe('api=peer-3')
    replacement.close()
  } finally {
    transport.dispose()
    delayed?.destroy()
    for (const socket of sockets.clients) socket.terminate()
    await new Promise<void>((resolve) =>{  sockets.close(() =>{  resolve() }) })
    await new Promise<void>(resolve => server.close(() =>{  resolve() }))
  }
})
