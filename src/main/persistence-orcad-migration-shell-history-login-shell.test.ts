import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { injectHistoryEnv } from './terminal-history'
import { getHistoryRoot } from './terminal-history-paths'
import { DORMANT_WORKTREE_ID, manifest } from './persistence-orcad-migration-catalog-fixture'
import {
  BASH,
  ZSH,
  commitDurably,
  encodedHistories,
  hostHistory,
  hostHistoryDirectory,
  stage
} from './persistence-orcad-migration-shell-history-fixture'
import { createStore, testState } from './persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))

let desktopHistory: string

// The WSL bridge's lone `bash_history`, written by whatever the distro's login shell is.
async function moveLoneBridgeHistory(content: string): Promise<void> {
  const input = manifest()
  const store = createStore()
  stage(
    store,
    input,
    await encodedHistories(desktopHistory, [
      { worktreeId: DORMANT_WORKTREE_ID, file: 'bash_history', content }
    ])
  )
  expect(await commitDurably(store, input)).toBe('committed')
}

describe('moved WSL history lands under the host login shell', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-migration-login-shell-'))
    desktopHistory = mkdtempSync(join(tmpdir(), 'orca-desktop-history-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
    rmSync(desktopHistory, { recursive: true, force: true })
    rmSync(getHistoryRoot(), { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('a zsh login shell gets zsh_history, the HISTFILE a new zsh pane reads', async () => {
    vi.stubEnv('SHELL', '/usr/bin/zsh')
    await moveLoneBridgeHistory(ZSH)

    expect(hostHistory(DORMANT_WORKTREE_ID, 'zsh_history')).toBe(ZSH)
    expect(hostHistory(DORMANT_WORKTREE_ID, 'bash_history')).toBeNull()
    const env: Record<string, string> = {}
    const injected = injectHistoryEnv(env, DORMANT_WORKTREE_ID, '/usr/bin/zsh', '/srv/x')
    expect(injected.histFile).toBe(join(hostHistoryDirectory(DORMANT_WORKTREE_ID), 'zsh_history'))
  })

  it('a bash login shell keeps bash_history', async () => {
    vi.stubEnv('SHELL', '/bin/bash')
    await moveLoneBridgeHistory(BASH)

    expect(hostHistory(DORMANT_WORKTREE_ID, 'bash_history')).toBe(BASH)
    expect(hostHistory(DORMANT_WORKTREE_ID, 'zsh_history')).toBeNull()
  })

  it.each(['/usr/bin/fish', '/usr/local/bin/nu'])(
    'any other login shell (%s) keeps bash_history',
    async (shell) => {
      vi.stubEnv('SHELL', shell)
      await moveLoneBridgeHistory(BASH)

      expect(hostHistory(DORMANT_WORKTREE_ID, 'bash_history')).toBe(BASH)
      expect(hostHistory(DORMANT_WORKTREE_ID, 'zsh_history')).toBeNull()
    }
  )

  it('a worktree that sent both files keeps their own names', async () => {
    vi.stubEnv('SHELL', '/usr/bin/zsh')
    const input = manifest()
    const store = createStore()
    stage(
      store,
      input,
      await encodedHistories(desktopHistory, [
        { worktreeId: DORMANT_WORKTREE_ID, file: 'zsh_history', content: ZSH },
        { worktreeId: DORMANT_WORKTREE_ID, file: 'bash_history', content: BASH }
      ])
    )
    expect(await commitDurably(store, input)).toBe('committed')

    expect(hostHistory(DORMANT_WORKTREE_ID, 'zsh_history')).toBe(ZSH)
    expect(hostHistory(DORMANT_WORKTREE_ID, 'bash_history')).toBe(BASH)
  })
})
