import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeChatMessage } from '../../src/shared/native-chat-types'

export const RENDER_SCROLL_ROW_COUNT = 420
export const RENDER_SCROLL_TICK_MS = 1000
const REPLY_STEPS = 24
const START = Date.now() - RENDER_SCROLL_ROW_COUNT * 1000

export function nativeChatRenderScrollEnabled(): boolean {
  return process.env.MOCK_NATIVE_CHAT_SCENARIO === 'ipad-render-scroll'
}

function paragraph(chat: string, row: number, part: number): string {
  return `Chat ${chat}, row ${row}, paragraph ${part}: follow this sentence through a narrow window and back to full width. The orchard path passes the library, crosses the river, and reaches the station. Keep these words readable while older messages load and the newest reply grows. **Remember this location** and compare its position after the next action.`
}

function rowText(chat: string, row: number): string {
  const marker = row === 1 ? 'FIRST' : row === RENDER_SCROLL_ROW_COUNT ? 'LAST' : 'ROW'
  const prose = Array.from({ length: 2 + (row % 4) }, (_, part) =>
    paragraph(chat, row, part + 1)
  ).join('\n\n')
  const formats = [
    '- Read the first paragraph slowly.\n- Keep the current message visible.\n- Compare the next window width.',
    '> A quoted observation spans several lines in a narrow window.\n> It should remain readable after the window changes width.',
    '```typescript\nconst widths = [640, 820, 1024]\nfor (const width of widths) {\n  console.log({ width, readable: true })\n}\n```',
    '| Action | Expected location |\n| --- | --- |\n| Resize | Same words |\n| Page history | Same message |',
    '1. Open the latest reply.\n2. Read several older messages.\n3. Switch to the other chat.\n4. Return to this message.',
    '```json\n{\n  "message": "variable height",\n  "checks": ["initial load", "resize", "settlement"]\n}\n```'
  ]
  return `## [IPAD ${chat} ${marker} ${String(row).padStart(3, '0')}]\n\n${prose}\n\n${formats[Math.floor((row - 1) / 2) % formats.length]}\n\nEnd of chat ${chat} row ${row}.`
}

function message(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  timestamp: number
): NativeChatMessage {
  return { id, role, blocks: [{ type: 'text', text }], timestamp, source: 'transcript' }
}

function replyParts(chat: string): string[] {
  return Array.from({ length: REPLY_STEPS }, (_, index) => {
    const heading =
      index === 0 ? `## [IPAD ${chat} STREAM]\n\n` : `### Reply section ${index + 1}\n\n`
    return `${heading}${paragraph(chat, RENDER_SCROLL_ROW_COUNT + 2, index + 1)}\n\n\`\`\`typescript\nconst section = ${index + 1}\nconsole.log(section)\n\`\`\`\n\n`
  })
}

type RenderScrollReplyState = { replyStartedAt: number | null; extraMessages: NativeChatMessage[] }

const emptyReplyState = (): RenderScrollReplyState => ({ replyStartedAt: null, extraMessages: [] })

function createRenderScrollChat(label: string, index: number) {
  return {
    label,
    tabId: `ipad-chat-${label.toLowerCase()}`,
    leafId:
      index === 0 ? '6e6a321d-f39c-40f2-8b54-a18430b2b1e1' : '13112886-8d67-4a37-b59d-ccdd32962546',
    terminal: `ipad-chat-term-${label.toLowerCase()}`,
    sessionId: `mock-ipad-chat-${label.toLowerCase()}`,
    transcriptPath: join(tmpdir(), `mock-ipad-chat-${label.toLowerCase()}.jsonl`),
    messages: Array.from({ length: RENDER_SCROLL_ROW_COUNT }, (_, row) =>
      message(
        `ipad-${label.toLowerCase()}-${row + 1}`,
        row % 2 === 0 ? 'user' : 'assistant',
        rowText(label, row + 1),
        START + row * 1000
      )
    ),
    replyParts: replyParts(label),
    generation: 0,
    turn: 0,
    lastControl: 'idle',
    updatedAt: START + RENDER_SCROLL_ROW_COUNT * 1000,
    ...emptyReplyState()
  }
}

export type RenderScrollChat = ReturnType<typeof createRenderScrollChat>
let chats: RenderScrollChat[] | undefined

export function getRenderScrollChats(): RenderScrollChat[] {
  chats ??= ['A', 'B'].map(createRenderScrollChat)
  return chats
}

export function findRenderScrollChat(selector: unknown): RenderScrollChat | undefined {
  return getRenderScrollChats().find((chat) =>
    [chat.tabId, `${chat.tabId}::${chat.leafId}`, chat.terminal, chat.sessionId].includes(
      String(selector)
    )
  )
}

export function startRenderScrollReply(chat: RenderScrollChat, prompt: string): void {
  if (chat.replyStartedAt !== null || chat.turn > 0) {
    return
  }
  chat.turn += 1
  chat.replyStartedAt = Date.now()
  chat.updatedAt = chat.replyStartedAt
  chat.extraMessages.push(
    message(`${chat.sessionId}-prompt-${chat.turn}`, 'user', prompt, chat.updatedAt)
  )
}

function replyText(chat: RenderScrollChat, steps: number): string {
  return chat.replyParts.slice(0, steps).join('')
}

function commitReply(chat: RenderScrollChat): void {
  if (chat.replyStartedAt === null) {
    return
  }
  const timestamp = Date.now()
  chat.extraMessages.push(
    message(
      `${chat.sessionId}-reply-${chat.turn}`,
      'assistant',
      `${replyText(chat, REPLY_STEPS)}[IPAD ${chat.label} COMMITTED LAST turn=${chat.turn}]`,
      timestamp
    )
  )
  chat.replyStartedAt = null
  chat.updatedAt = timestamp
}

export function advanceRenderScrollChat(chat: RenderScrollChat): void {
  let control: unknown
  try {
    const file =
      process.env.MOCK_NATIVE_CHAT_REPLY_CONTROL_FILE ??
      join(tmpdir(), 'orca-mock-native-chat-reply.json')
    const raw: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    if (raw && typeof raw === 'object') {
      control = Reflect.get(raw, chat.label.toLowerCase())
    }
  } catch {
    // Missing or partially written controls leave the current turn alone.
  }
  if (typeof control === 'string' && control !== chat.lastControl) {
    chat.lastControl = control
    if (control === 'reset') {
      chat.generation += 1
      chat.turn = 0
      chat.replyStartedAt = null
      chat.extraMessages = []
      chat.updatedAt = Date.now()
    } else if (control === 'stream') {
      startRenderScrollReply(chat, `Please write a long reply for chat ${chat.label}.`)
    } else if (control === 'finish') {
      commitReply(chat)
    }
  }
  if (
    chat.replyStartedAt !== null &&
    Date.now() - chat.replyStartedAt >= REPLY_STEPS * RENDER_SCROLL_TICK_MS
  ) {
    commitReply(chat)
  }
}

export function renderScrollPreview(chat: RenderScrollChat): string | undefined {
  advanceRenderScrollChat(chat)
  if (chat.replyStartedAt === null) {
    return undefined
  }
  const steps = Math.min(
    REPLY_STEPS,
    1 + Math.floor((Date.now() - chat.replyStartedAt) / RENDER_SCROLL_TICK_MS)
  )
  chat.updatedAt = chat.replyStartedAt + (steps - 1) * RENDER_SCROLL_TICK_MS
  return replyText(chat, steps)
}

export function renderScrollTranscript(chat: RenderScrollChat): NativeChatMessage[] {
  advanceRenderScrollChat(chat)
  return [...chat.messages, ...chat.extraMessages]
}

export function readRenderScrollPage(
  chat: RenderScrollChat,
  params?: Record<string, unknown>
): { messages: NativeChatMessage[]; hasMore: boolean; beforeOffset: number } {
  const all = renderScrollTranscript(chat)
  const rawLimit = params?.limit
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(2000, Math.floor(rawLimit)))
      : 40
  const rawCursor = params?.beforeOffset
  const end =
    typeof rawCursor === 'number' && Number.isFinite(rawCursor)
      ? Math.max(0, Math.min(all.length, Math.floor(rawCursor)))
      : all.length
  const start = Math.max(0, end - limit)
  return { messages: all.slice(start, end), hasMore: start > 0, beforeOffset: start }
}
