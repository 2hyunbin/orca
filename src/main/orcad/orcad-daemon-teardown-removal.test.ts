import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import { removeTestRoot } from './orcad-daemon-teardown-fixture'

vi.mock('../../shared/windows-transient-lock-removal', () => ({ removeTree: vi.fn() }))

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function failTimes(times: number, code: string): void {
  let calls = 0
  vi.mocked(removeTree).mockImplementation(async () => {
    calls += 1
    if (calls <= times) {
      throw Object.assign(new Error(code), { code })
    }
  })
}

async function settle(removal: Promise<void>): Promise<unknown> {
  const outcome = removal.then(
    () => 'removed',
    (error: unknown) => error
  )
  await vi.runAllTimersAsync()
  return outcome
}

describe('removeTestRoot Windows busy hold', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(removeTree).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    setPlatform(originalPlatform)
  })

  it('outlasts an EBUSY hold longer than its attempts within the hold window', async () => {
    setPlatform('win32')
    failTimes(40, 'EBUSY')
    expect(await settle(removeTestRoot('root', 10_000))).toBe('removed')
    expect(removeTree).toHaveBeenCalledTimes(41)
  })

  it('still fails an EBUSY that outlives the hold window', async () => {
    setPlatform('win32')
    failTimes(Number.POSITIVE_INFINITY, 'EBUSY')
    expect(await settle(removeTestRoot('root', 1_000))).toMatchObject({ code: 'EBUSY' })
  })

  it('keeps the attempt bound for ENOTEMPTY, a late writer rather than a held directory', async () => {
    setPlatform('win32')
    failTimes(Number.POSITIVE_INFINITY, 'ENOTEMPTY')
    expect(await settle(removeTestRoot('root', 10_000))).toMatchObject({ code: 'ENOTEMPTY' })
    expect(removeTree).toHaveBeenCalledTimes(8)
  })

  it('ignores the hold off Windows', async () => {
    setPlatform('linux')
    failTimes(Number.POSITIVE_INFINITY, 'EBUSY')
    expect(await settle(removeTestRoot('root', 10_000))).toMatchObject({ code: 'EBUSY' })
    expect(removeTree).toHaveBeenCalledTimes(8)
  })
})
