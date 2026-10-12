import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Store } from '../persistence/loading-store/store'
import { ProfileStateSqliteAuthority } from '../persistence/profile-state/profile-state-sqlite-authority'
import { OrcaRuntimeService } from './orca-runtime'

it('captures the root repo resolver before reading the selector argument', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-prefetch-dispatch-'))
  const authority = new ProfileStateSqliteAuthority(
    join(directory, 'profile-state.db'),
    'prefetch-dispatch'
  )
  const store = new Store({
    dataFile: join(directory, 'orca-data.json'),
    profileStateAuthority: authority
  })

  try {
    const runtime = new OrcaRuntimeService(store)
    const events: string[] = []
    const original = vi.fn(function (this: typeof runtime, selector: string) {
      expect(this).toBe(runtime)
      expect(arguments.length).toBe(1)
      expect(selector).toBe('repo')
      events.push('original resolver')
      throw new Error('original resolver')
    })
    const replacement = vi.fn(() => {
      throw new Error('replacement resolver')
    })
    Object.defineProperty(runtime, 'resolveRepoSelector', {
      configurable: true,
      get: () => {
        events.push('resolver read')
        return original
      }
    })

    await expect(
      runtime.prefetchManagedWorktreeCreateBase({
        get repoSelector() {
          events.push('selector read')
          Object.defineProperty(runtime, 'resolveRepoSelector', { value: replacement })
          return 'repo'
        }
      })
    ).rejects.toThrow('original resolver')

    expect(events).toEqual(['resolver read', 'selector read', 'original resolver'])
    expect(original).toHaveBeenCalledOnce()
    expect(replacement).not.toHaveBeenCalled()
  } finally {
    store.freezeWrites()
    authority.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
