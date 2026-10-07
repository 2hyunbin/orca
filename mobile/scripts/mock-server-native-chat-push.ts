import type { WebSocket } from 'ws'

const pushLoops = new WeakMap<WebSocket, Map<string, ReturnType<typeof setInterval>>>()

export function stopNativeChatPush(ws: WebSocket, key: string): void {
  const loops = pushLoops.get(ws)
  const timer = loops?.get(key)
  if (timer !== undefined) {
    clearInterval(timer)
    loops?.delete(key)
  }
}

export function startNativeChatPush(
  ws: WebSocket,
  key: string,
  push: () => void,
  intervalMs = 3000
): void {
  stopNativeChatPush(ws, key)
  const timer = setInterval(() => {
    if (ws.readyState !== ws.OPEN) {
      stopNativeChatPush(ws, key)
      return
    }
    push()
  }, intervalMs)
  let loops = pushLoops.get(ws)
  if (!loops) {
    loops = new Map()
    pushLoops.set(ws, loops)
    ws.once('close', () => {
      for (const interval of pushLoops.get(ws)?.values() ?? []) {
        clearInterval(interval)
      }
      pushLoops.delete(ws)
    })
  }
  loops.set(key, timer)
}
