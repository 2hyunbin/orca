import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  createMobileNativeChatStreamingGate,
  deriveMobileNativeChatStreaming
} from './mobile-native-chat-streaming-gate'

const assistant = (id: string, text: string): NativeChatMessage => ({
  id,
  role: 'assistant',
  blocks: [{ type: 'text', text }],
  timestamp: 0,
  source: 'transcript'
})
function sequence() {
  let gate = createMobileNativeChatStreamingGate('chat')
  return (
    folded: NativeChatMessage[],
    text?: string,
    options: {
      streamLive?: boolean
      sourceSettled?: boolean
      abandon?: boolean
      scopeKey?: string
    } = {}
  ) => {
    const step = deriveMobileNativeChatStreaming(gate, folded, text, options)
    gate = step.gate
    return step
  }
}

describe('observed preview lifetime and adopted presentation identity', () => {
  it('holds displayed words through idle/no observation and settles through the same entry', () => {
    const tick = sequence()
    const prior = [assistant('prior', 'earlier')]
    tick(prior)
    const observed = tick(prior, 'answer', { streamLive: true })
    expect(tick(prior, undefined, { streamLive: false }).streaming).toBe('answer')
    const final = [...prior, assistant('final', 'answer complete')]
    const landed = tick(final, undefined, { streamLive: false })
    expect(landed.streaming).toBeNull()
    expect(landed.presentationKeys.final).toBe(observed.streamingKey)
    for (let pass = 0; pass < 5; pass++) {
      const textless = tick(final, undefined, { streamLive: false })
      expect(textless.streaming).toBeNull()
      expect(textless.presentationKeys.final).toBe(observed.streamingKey)
      expect(textless.gate).toBe(landed.gate)
    }
  })
  it('retains known words through a tool gap without treating tool output as another observation', () => {
    const tick = sequence()
    const prior = [assistant('prior', 'earlier')]
    tick(prior)
    const first = tick(prior, 'part one', { streamLive: true })
    expect(tick(prior, undefined, { streamLive: true }).streaming).toBe('part one')
    const committed = [...prior, assistant('one', 'part one complete')]
    expect(tick(committed, undefined, { streamLive: true }).presentationKeys.one).toBe(
      first.streamingKey
    )
    const second = tick(committed, 'part two', { streamLive: true })
    expect(second.streaming).toBe('part two')
    expect(second.streamingKey).not.toBe(first.streamingKey)
    expect(second.presentationKeys.one).toBe(first.streamingKey)
  })
  it('starts an equal-prefix reply in a new foreground turn without renaming the prior final', () => {
    const tick = sequence()
    const prior = [assistant('prior', 'Done.')]
    tick(prior)
    const first = tick(prior, 'Done.', { streamLive: true })
    const final = [...prior, assistant('one', 'Done.')]
    tick(final, undefined, { streamLive: false })
    const second = tick(final, 'Done.', { streamLive: true })
    expect(second.streaming).toBe('Done.')
    expect(second.streamingKey).not.toBe(first.streamingKey)
    expect(second.presentationKeys.one).toBe(first.streamingKey)
  })
  it('survives hidden-view gaps and the same-session scope, but replaces a genuine new scope', () => {
    const tick = sequence()
    const prior = [assistant('prior', 'earlier')]
    tick(prior)
    const observed = tick(prior, 'answer', { streamLive: true })
    const final = [...prior, assistant('final', 'answer complete')]
    tick(final, undefined)
    tick([], undefined, { sourceSettled: false })
    expect(tick(final, undefined, { sourceSettled: true }).presentationKeys.final).toBe(
      observed.streamingKey
    )
    const replaced = tick(final, undefined, { scopeKey: 'other' })
    expect(replaced.streaming).toBeNull()
    expect(replaced.presentationKeys).toEqual({})
  })
  it('supersedes a missing final when different source content arrives and never replays the obsolete status', () => {
    const tick = sequence()
    const prior = [assistant('prior', 'earlier')]
    tick(prior)
    tick(prior, 'unpublished', { streamLive: true })
    expect(tick(prior, undefined).streaming).toBe('unpublished')
    const superseding = [...prior, assistant('other', 'different authoritative content')]
    expect(tick(superseding, undefined).streaming).toBeNull()
    expect(tick(superseding, 'unpublished').streaming).toBeNull()
    expect(tick(superseding, undefined).streaming).toBeNull()
  })
  it('eviction and explicit abandon end the observed segment, without retries or a permanent latch', () => {
    const tick = sequence()
    const prior = [assistant('prior', 'earlier')]
    tick(prior)
    tick(prior, 'unpublished', { streamLive: true })
    const evicted = tick([], undefined, { sourceSettled: true })
    expect(evicted.streaming).toBeNull()
    expect(tick([], undefined, { sourceSettled: true }).gate).toBe(evicted.gate)
    tick(prior)
    tick(prior, 'stopped output', { streamLive: true })
    const stopped = tick(prior, undefined, { abandon: true })
    expect(stopped.streaming).toBeNull()
    expect(tick(prior, undefined, { abandon: true }).gate).toBe(stopped.gate)
    expect(tick(prior, 'another reply', { streamLive: true }).streaming).toBe('another reply')
  })
  it('bounds adopted associations to loaded entries and uses fallback for unmatched final text', () => {
    const tick = sequence()
    let loaded = [assistant('prior', 'earlier')]
    tick(loaded)
    for (let turn = 0; turn < 12; turn++) {
      tick(loaded, `answer ${turn}`, { streamLive: true, sourceSettled: true })
      loaded.push(assistant(`final-${turn}`, `answer ${turn} complete`))
      tick(loaded, undefined, { sourceSettled: true })
      loaded = loaded.slice(-3)
    }
    const final = tick(loaded, undefined, { sourceSettled: true })
    expect(Object.keys(final.presentationKeys).length).toBeLessThanOrEqual(3)
    expect(
      Object.keys(final.presentationKeys).every((id) => loaded.some((entry) => entry.id === id))
    ).toBe(true)
    const unknown = tick(loaded, 'a new segment', { streamLive: true })
    const replacement = tick([...loaded, assistant('unmatched', 'unrelated final')], undefined)
    expect(replacement.streaming).toBeNull()
    expect(replacement.presentationKeys.unmatched).toBeUndefined()
    expect(replacement.streamingKey).toBe(unknown.streamingKey)
  })
})
