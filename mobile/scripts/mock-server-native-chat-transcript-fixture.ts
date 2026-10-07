import type { WebSocket } from 'ws'
import type { RpcRequest, RpcRespond, RpcResponse } from './mock-server-rpc-handlers'
import { startNativeChatPush, stopNativeChatPush } from './mock-server-native-chat-push'
import {
  findRenderScrollChat,
  readRenderScrollPage,
  renderScrollTranscript,
  RENDER_SCROLL_TICK_MS
} from './mock-server-native-chat-render-scroll-fixture'

type Success = (id: string, result: unknown, streaming?: boolean) => RpcResponse
type Failure = (id: string, code: string, message: string) => RpcResponse

export function handleRenderScrollTranscriptRequest(
  request: RpcRequest,
  respond: RpcRespond,
  success: Success,
  error: Failure,
  ws: WebSocket
): boolean {
  if (
    !['nativeChat.subscribe', 'nativeChat.readSession', 'nativeChat.unsubscribe'].includes(
      request.method
    )
  ) {
    return false
  }
  const key = `transcript:${String(request.params?.subscriptionId ?? request.params?.sessionId)}`
  if (request.method === 'nativeChat.unsubscribe') {
    stopNativeChatPush(ws, key)
    respond(success(request.id, { ok: true }))
    return true
  }
  const chat = findRenderScrollChat(request.params?.sessionId)
  if (!chat) {
    respond(error(request.id, 'session_not_found', 'Unknown mock iPad chat session'))
    return true
  }
  const page = readRenderScrollPage(chat, request.params)
  if (request.method === 'nativeChat.readSession') {
    respond(success(request.id, page))
    return true
  }
  respond(success(request.id, { type: 'snapshot', ...page }, true))
  let generation = chat.generation
  let count = renderScrollTranscript(chat).length
  startNativeChatPush(
    ws,
    key,
    () => {
      const all = renderScrollTranscript(chat)
      if (generation !== chat.generation) {
        generation = chat.generation
        count = all.length
        respond(
          success(
            request.id,
            { type: 'replacement', ...readRenderScrollPage(chat, request.params) },
            true
          )
        )
      } else if (all.length > count) {
        const messages = all.slice(count)
        count = all.length
        respond(success(request.id, { type: 'appended', messages }, true))
      }
    },
    RENDER_SCROLL_TICK_MS
  )
  return true
}
