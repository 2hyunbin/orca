import { afterEach, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { WebSocketTransport } from './ws-transport'

const transports: WebSocketTransport[] = []
const clients: WebSocket[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.terminate()
  }
  await Promise.all(transports.splice(0).map((transport) => transport.stop()))
})

it.each([
  '/_orca/managed/child/2',
  '/_orca/managed/child/0',
  '/%5forca/managed/child/2',
  '/%5forca/managed/%zz/2',
  '/%255forca/managed/%zz/2',
  '/_orca/managed'
])('refuses unsupported gateway %s before delivering root messages', async (path) => {
  const transport = new WebSocketTransport({ host: '127.0.0.1', port: 0 })
  const rootMessages = vi.fn()
  transport.onMessage(rootMessages)
  transports.push(transport)
  await transport.start()
  const client = new WebSocket(`ws://127.0.0.1:${transport.resolvedPort}${path}`)
  clients.push(client)
  const closed = new Promise<number>((resolve, reject) => {
    client.once('close', (code) => resolve(code))
    client.once('error', reject)
  })
  client.once('open', () => client.send('must-not-reach-controller'))
  expect(await closed).toBe(1008)
  expect(rootMessages).not.toHaveBeenCalled()
})

it('continues serving the root transport', async () => {
  const transport = new WebSocketTransport({ host: '127.0.0.1', port: 0 })
  transport.onMessage((message, reply) => {
    if (typeof message === 'string') {
      reply(`root:${message}`)
    }
  })
  transports.push(transport)
  await transport.start()
  const client = new WebSocket(`ws://127.0.0.1:${transport.resolvedPort}/`)
  clients.push(client)
  const response = new Promise<string>((resolve, reject) => {
    client.once('message', (bytes) => {
      const buffer = Array.isArray(bytes)
        ? Buffer.concat(bytes)
        : bytes instanceof ArrayBuffer
          ? Buffer.from(bytes)
          : bytes
      resolve(buffer.toString())
    })
    client.once('error', reject)
  })
  client.once('open', () => client.send('hello'))
  expect(await response).toBe('root:hello')
})
