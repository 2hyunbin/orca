import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

/** Reconciles one observed segment against the transcript tail that preceded it. */
export type MobileNativeChatStreamingGate = {
  scopeKey: string | null
  prevText: string
  baselineTailId: string | null
  segment: number
  displayed: boolean
  matchedTailId: string | null
  streamLive: boolean
  superseded: boolean
  /** Only adopted entries still in the loaded source window are retained. */
  presentationKeys: Readonly<Record<string, string>>
}

export type MobileNativeChatStreamingPresentation = {
  gate: MobileNativeChatStreamingGate
  streaming: string | null
  streamingKey: string
  presentationKeys: Readonly<Record<string, string>>
}

/** The preview text to feed the gate for one tick, or undefined for "no observation".
 *
 *  Providers publish a tool's stdout/error as `lastAssistantMessage` so status cards can
 *  preview it. That text is not the reply and never lands in a transcript assistant block,
 *  so the catch-up rule below could never retire it — it stayed on screen as a wall of raw
 *  tool output until the turn ended. Treating it as no observation (rather than empty text
 *  that still anchors) also keeps it out of `prevText`, so the next real reply is not
 *  mistaken for a continuation of a tool result. */
export function mobileNativeChatStreamPreview(
  status:
    | { lastAssistantMessage?: string; lastAssistantMessageIsToolOutput?: boolean }
    | null
    | undefined,
  working: boolean
): string | undefined {
  if (!working || status?.lastAssistantMessageIsToolOutput === true) {
    return undefined
  }
  return status?.lastAssistantMessage
}

export function createMobileNativeChatStreamingGate(
  scopeKey: string | null = null
): MobileNativeChatStreamingGate {
  return {
    scopeKey,
    prevText: '',
    baselineTailId: null,
    segment: 0,
    displayed: false,
    matchedTailId: null,
    streamLive: false,
    superseded: false,
    presentationKeys: {}
  }
}

function assistantTailText(tail: NativeChatMessage | undefined): string {
  if (!tail || tail.role !== 'assistant') {
    return ''
  }
  return tail.blocks
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim()
}

/** No observation retires neither displayed words nor a matched entry's identity. */
export function deriveMobileNativeChatStreaming(
  gate: MobileNativeChatStreamingGate,
  folded: readonly NativeChatMessage[],
  streamingText: string | undefined,
  options: {
    scopeKey?: string | null
    streamLive?: boolean
    sourceSettled?: boolean
    abandon?: boolean
  } = {}
): MobileNativeChatStreamingPresentation {
  const scopeKey = options.scopeKey === undefined ? gate.scopeKey : options.scopeKey
  const current = gate.scopeKey === scopeKey ? gate : createMobileNativeChatStreamingGate(scopeKey)
  const live = options.streamLive === true
  const observation = streamingText?.trim() ?? ''
  const tail = folded.at(-1)
  const tailId = tail?.id ?? null
  const ids = new Set(folded.map((message) => message.id))
  const presentationKeys =
    options.sourceSettled === false
      ? current.presentationKeys
      : Object.fromEntries(Object.entries(current.presentationKeys).filter(([id]) => ids.has(id)))
  const sourceEvicted =
    options.sourceSettled === true &&
    ((folded.length === 0 && current.prevText !== '' && current.baselineTailId !== null) ||
      (current.baselineTailId !== null &&
        !ids.has(current.baselineTailId) &&
        (current.matchedTailId === null || !ids.has(current.matchedTailId))))
  const restart =
    (live && !current.streamLive && current.prevText !== '') ||
    (observation !== '' && current.prevText !== '' && !observation.startsWith(current.prevText))
  let next = { ...current, presentationKeys, streamLive: live }
  const abandon =
    options.abandon === true && (current.prevText !== '' || current.matchedTailId !== null)
  if (abandon || sourceEvicted || restart) {
    next = {
      ...next,
      prevText: '',
      baselineTailId: restart ? (current.matchedTailId ?? tailId) : tailId,
      displayed: false,
      matchedTailId: null,
      superseded: false,
      segment: current.segment + 1
    }
  }
  let text = observation || next.prevText
  if (options.abandon || sourceEvicted) {
    text = ''
  }
  if (!text) {
    if (tailId !== null && (!live || next.baselineTailId === null)) {
      next.baselineTailId = tailId
    }
  } else {
    const caughtUp = tailId !== next.baselineTailId && assistantTailText(tail).startsWith(text)
    if (caughtUp && tailId !== null) {
      if (next.displayed && next.matchedTailId === null) {
        next.presentationKeys = { ...next.presentationKeys, [tailId]: `streaming:${next.segment}` }
      }
      next.matchedTailId = tailId
    } else if (
      next.matchedTailId === null &&
      tailId !== next.baselineTailId &&
      tailId !== null &&
      current.prevText !== '' &&
      !live &&
      observation === ''
    ) {
      // Different published content supersedes the observation; no identity guess.
      next.superseded = true
      next.displayed = false
    }
  }
  next.prevText = text
  const streaming = text && next.matchedTailId === null && !next.superseded ? text : null
  if (streaming !== null) {
    next.displayed = true
  }
  // The gate is render-derived state; repeated inputs must settle without another render.
  const unchanged = Object.entries(next).every(([key, value]) =>
    key === 'presentationKeys'
      ? Object.keys(next.presentationKeys).length ===
          Object.keys(current.presentationKeys).length &&
        Object.entries(next.presentationKeys).every(
          ([id, presentationKey]) => current.presentationKeys[id] === presentationKey
        )
      : value === Reflect.get(current, key)
  )
  const resultGate = unchanged ? current : next
  return {
    gate: resultGate,
    streaming,
    streamingKey: `streaming:${resultGate.segment}`,
    presentationKeys: resultGate.presentationKeys
  }
}
