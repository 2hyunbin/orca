import { describe, expect, it } from 'vitest'
import { nativeChatComposerStops } from './native-chat-composer-primary-action'

describe('the composer button', () => {
  it.each([
    { isWorking: false, hasContent: false, stops: false },
    { isWorking: true, hasContent: true, stops: true },
    { isWorking: true, hasContent: false, sendsWhileWorking: true, stops: true },
    { isWorking: true, hasContent: true, sendsWhileWorking: true, stops: false }
  ])(
    'working $isWorking, content $hasContent, sends while working $sendsWhileWorking: stops $stops',
    ({ stops, ...input }) => {
      expect(nativeChatComposerStops(input)).toBe(stops)
    }
  )
})
