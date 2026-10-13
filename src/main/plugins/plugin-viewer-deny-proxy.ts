import { createServer } from 'node:net'

export async function createPluginViewerDenyProxy() {
  let available = false
  const server = createServer({ pauseOnConnect: true }, (socket) => socket.destroy())
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('plugin_viewer_proxy_unavailable'))
        return
      }
      available = true
      resolve(address.port)
    })
  })
  server.on('error', () => {
    available = false
  })
  server.once('close', () => {
    available = false
  })
  let disposal: Promise<void> | undefined
  return {
    endpoint: Object.freeze({ host: '127.0.0.1' as const, port }),
    isAvailable: () => available,
    dispose(): Promise<void> {
      available = false
      disposal ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      return disposal
    }
  }
}
