import { expect, vi } from 'vitest'
import * as shell from './tui-agent-startup-shell'
import type { GlobalSettings } from './global-settings-types'
import { getDefaultVoiceSettings } from './constants'
import { getDefaultNotificationSettings } from './notification-settings-defaults'
import { buildDefaultSettings } from './default-global-settings'

// Why: tests need a complete GlobalSettings without hand-copying every field, so
// new settings only have to be added to buildDefaultSettings, not each fixture.
export function createGlobalSettingsFixture(
  overrides: Partial<GlobalSettings> = {}
): GlobalSettings {
  return {
    ...buildDefaultSettings({
      // Callers supply the real directory; no platform-specific default belongs here.
      workspaceDir: overrides.workspaceDir ?? '',
      appFontFamily: 'Geist',
      editorAutoSaveDelayMs: 1000,
      primarySelectionMiddleClickPaste: false,
      primarySelectionDefaultedForLinux: false,
      terminalFontFamily: 'JetBrains Mono',
      terminalInactivePaneOpacity: 0.5,
      terminalRightClickToPaste: false,
      notifications: getDefaultNotificationSettings(),
      voice: getDefaultVoiceSettings()
    }),
    ...overrides
  }
}

const originalTokenizer = shell.tokenizeStartupCommand

// Native materializations and string outputs; callers add the finite semantic/property passes.
export function measureSettingsWork<T>(call: () => T) {
  const work = {
    entries: 0,
    assignments: 0,
    comparisons: 0,
    bytes: 0,
    chars: 0,
    visits: 0,
    inputs: Array<string>()
  }
  const currentTokenizer = shell.tokenizeStartupCommand
  const existingTokenizerSpy = vi.isMockFunction(currentTokenizer)
  const tokenize = vi.isMockFunction(currentTokenizer)
    ? (currentTokenizer.getMockImplementation() ?? originalTokenizer)
    : currentTokenizer
  const tokenizerSpy = vi.spyOn(shell, 'tokenizeStartupCommand')
  tokenizerSpy.mockImplementation((...args) => {
    work.inputs.push(args[0])
    work.chars += args[0].length
    const parsed = tokenize(...args)
    // Fixed token/span/owner passes; this is not a dynamic index-read counter.
    if (parsed.ok) {
      work.visits += 10 * parsed.tokens.length
    }
    return parsed
  })
  const restores: (() => void)[] = []
  for (const [target, names] of [
    [Object, ['entries', 'keys', 'fromEntries', 'hasOwn', 'assign']],
    [Map.prototype, ['get', 'set', 'delete']],
    [Set.prototype, ['add', 'has']],
    [Array.prototype, ['sort', 'slice']],
    [String.prototype, ['slice', 'toLowerCase']]
  ] as const) {
    for (const name of names) {
      const original = Reflect.get(target, name)
      Reflect.set(target, name, function (this: object, ...args: unknown[]) {
        if (name === 'sort') {
          const compare = args[0]
          args[0] = (a: unknown, b: unknown) => {
            work.comparisons++
            return typeof compare === 'function'
              ? Reflect.apply(compare, undefined, [a, b])
              : +(String(a) > String(b)) - +(String(a) < String(b))
          }
        }
        const result = Reflect.apply(original, this, args)
        if (target === String.prototype) {
          work.bytes += result.length
        } else if (name === 'slice') {
          work.visits += 2 * result.length
        } else if (name === 'assign') {
          work.assignments++
          for (let i = 1; i < args.length; i++) {
            work.entries += 2 * Reflect.ownKeys(Object(args[i])).length
          }
        } else if (name === 'fromEntries') {
          work.entries += Reflect.ownKeys(result).length
        } else if (target === Object && name !== 'hasOwn') {
          work.entries += 2 * result.length
        } else if (name !== 'sort') {
          work.entries++
        }
        return result
      })
      restores.push(Reflect.set.bind(Reflect, target, name, original))
    }
  }
  work.entries = 0
  const restore = () => {
    restores.toReversed().forEach((reset) => reset())
    if (existingTokenizerSpy) {
      tokenizerSpy.mockImplementation(tokenize)
    } else {
      tokenizerSpy.mockRestore()
    }
  }
  let pending = false
  try {
    const value = call()
    pending = value instanceof Promise
    if (value instanceof Promise) {
      void value.then(restore, restore)
    }
    return { value, work }
  } finally {
    if (!pending) {
      restore()
    }
  }
}

const workScales = new Map<string, number[]>()
export function expectSettingsWorkScale(key: string, size: number, counts: number[]) {
  if (size === 200) {
    const baseline = workScales.get(key)
    expect(baseline, key).toBeDefined()
    counts.forEach((value, i) => expect(value, key).toBeLessThanOrEqual(12 * baseline![i]))
  }
  workScales.set(key, counts)
}
