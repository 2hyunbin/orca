import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf
} from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { writeWindowSaveWatchingLayout } from './window-save-divergence'

function session(tabs: { id: string; title?: string }[]): WorkspaceSessionState {
  return addWorkspace(emptySession(), GIT_KEY, [
    {
      id: 'group-1',
      tabs: tabs.map((tab, index) => {
        const leaves: [string, string?][] = [[leaf(index + 1)]]
        return { ...tab, leaves }
      })
    }
  ])
}

/** Runs a save that replaces the stored session with `next`, as the store would. */
function save(stored: WorkspaceSessionState, next: WorkspaceSessionState, hostId = 'local') {
  let current = stored
  writeWindowSaveWatchingLayout(
    () => current,
    hostId,
    () => {
      current = next
    },
    'session:set'
  )
  return current
}

describe('writeWindowSaveWatchingLayout', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  let logDir: string | null = null

  afterEach(() => {
    warn.mockClear()
    vi.unstubAllEnvs()
    if (logDir) {
      rmSync(logDir, { recursive: true, force: true })
      logDir = null
    }
  })

  it('stays quiet for a save that leaves main’s layout as it is', () => {
    const tabs = [{ id: 'tab-a' }, { id: 'tab-b' }]

    expect(save(session(tabs), session(tabs))).toEqual(session(tabs))
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports a tab the save added, dropped, renamed or moved, and still writes it', () => {
    logDir = mkdtempSync(join(tmpdir(), 'orca-divergence-'))
    const logPath = join(logDir, 'divergence.jsonl')
    vi.stubEnv('ORCA_LAYOUT_SAVE_DIVERGENCE_LOG', logPath)

    const next = session([{ id: 'tab-b', title: 'renamed' }, { id: 'tab-c' }])
    expect(save(session([{ id: 'tab-a' }, { id: 'tab-b' }]), next)).toBe(next)

    const [line] = readFileSync(logPath, 'utf8').trim().split('\n')
    const logged = JSON.parse(line!)
    expect(logged).toMatchObject({ source: 'session:set', partition: 'local', workspace: GIT_KEY })
    expect(logged.paths).toEqual(
      expect.arrayContaining([
        'tab tab-a removed',
        'tab tab-c added',
        'group group-1 changed: tabIds'
      ])
    )
    expect(warn).toHaveBeenCalledOnce()
  })

  it('reports a reorder of the same tabs', () => {
    save(session([{ id: 'tab-a' }, { id: 'tab-b' }]), session([{ id: 'tab-b' }, { id: 'tab-a' }]))

    expect(warn).toHaveBeenCalledWith(
      '[layout-owner] window save changed main layout:',
      'session:set',
      expect.objectContaining({ paths: expect.arrayContaining(['group group-1 changed: tabIds']) })
    )
  })

  it('leaves a paired server’s partition alone: its layout is the server’s', () => {
    const next = session([{ id: 'tab-c' }])
    expect(save(session([{ id: 'tab-a' }]), next, 'runtime:env-1')).toBe(next)
    expect(warn).not.toHaveBeenCalled()
  })
})
