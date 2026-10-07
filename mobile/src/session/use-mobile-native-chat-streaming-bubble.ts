import { useState } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  createMobileNativeChatStreamingGate,
  deriveMobileNativeChatStreaming
} from './mobile-native-chat-streaming-gate'

/** Lives above the transcript so the observed segment survives a terminal-view toggle. */
export function useMobileNativeChatStreamingPresentation(
  folded: readonly NativeChatMessage[],
  streamingText: string | undefined,
  scopeKey: string,
  streamLive: boolean,
  options: { sourceSettled?: boolean; abandon?: boolean } = {}
): ReturnType<typeof deriveMobileNativeChatStreaming> {
  const [gate, setGate] = useState(() => createMobileNativeChatStreamingGate(scopeKey))
  const step = deriveMobileNativeChatStreaming(gate, folded, streamingText, {
    scopeKey,
    streamLive,
    ...options
  })
  if (step.gate !== gate) {
    setGate(step.gate)
  }
  return step
}

export function useMobileNativeChatStreamingBubble(
  folded: readonly NativeChatMessage[],
  streamingText: string | undefined,
  scopeKey: string,
  streamLive: boolean
): string | null {
  return useMobileNativeChatStreamingPresentation(folded, streamingText, scopeKey, streamLive)
    .streaming
}
