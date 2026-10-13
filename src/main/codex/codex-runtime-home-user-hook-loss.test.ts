import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as CodexHomePaths from './codex-home-paths'

const paths = vi.hoisted(() => ({ systemHome: '' }))
vi.mock('./codex-home-paths', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexHomePaths>()),
  getSystemCodexHomePath: () => paths.systemHome
}))

import { runtimeHomeHasUnmirroredUserHooks } from './codex-runtime-home-user-hook-loss'

const USER_HOOK = { hooks: [{ type: 'command', command: '/usr/local/bin/notify-me' }] }
const ORCA_HOOK = { hooks: [{ type: 'command', command: '/x/agent-hooks/codex-hook.sh' }] }

function writeHooks(home: string, hooks: Record<string, unknown>): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks }))
}

describe('runtimeHomeHasUnmirroredUserHooks', () => {
  let root: string
  let accountHome: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-codex-hook-loss-'))
    paths.systemHome = join(root, '.codex')
    accountHome = join(root, 'account', 'home')
    mkdirSync(accountHome, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('reports nothing for a home without hooks.json or with only Orca entries', () => {
    expect(runtimeHomeHasUnmirroredUserHooks(accountHome)).toBe(false)
    writeHooks(accountHome, { Stop: [ORCA_HOOK] })
    expect(runtimeHomeHasUnmirroredUserHooks(accountHome)).toBe(false)
  })

  it('reports nothing when ~/.codex holds the same user hook', () => {
    writeHooks(paths.systemHome, { Stop: [USER_HOOK] })
    writeHooks(accountHome, { Stop: [ORCA_HOOK, USER_HOOK] })
    expect(runtimeHomeHasUnmirroredUserHooks(accountHome)).toBe(false)
  })

  it('reports a user hook only the account home holds', () => {
    writeHooks(paths.systemHome, {})
    writeHooks(accountHome, { Stop: [ORCA_HOOK, USER_HOOK] })
    expect(runtimeHomeHasUnmirroredUserHooks(accountHome)).toBe(true)
  })

  it('reports a user hook ~/.codex holds under another event', () => {
    writeHooks(paths.systemHome, { SessionStart: [USER_HOOK] })
    writeHooks(accountHome, { Stop: [USER_HOOK] })
    expect(runtimeHomeHasUnmirroredUserHooks(accountHome)).toBe(true)
  })
})
