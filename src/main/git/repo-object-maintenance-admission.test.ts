import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const capture = vi.hoisted(() =>
  vi.fn<
    (
      binary: string,
      argv: string[],
      options: { signal?: AbortSignal; onChildTerminated?: () => void; lowPriority?: boolean }
    ) => Promise<{ stdout: string; stderr: string }>
  >()
)
vi.mock('./command-runner/exec-file-capture', () => ({
  execFileCapture: capture,
  execFileCaptureToTermination: capture
}))
vi.mock('./runner', async () => import('./command-runner/git-exec-file'))
vi.mock('./git-version', () => ({ readHostGitVersion: async () => 'git version 2.55.0' }))
vi.mock('../observability/instrumentation', () => ({
  withGitSpan: async (_args: unknown, run: (span: unknown) => unknown) =>
    run({ setAttribute: () => {} })
}))

import { maintainRepoObjects } from './repo-object-maintenance'
import { OBJECT_MAINTENANCE_ARGS } from '../../shared/repo-object-maintenance-policy'
import { isGitWorktreeMutationInFlight } from './git-worktree-mutation-state'
import {
  GENERAL_CAP,
  GitAdmissionScheduler,
  acquireGitAdmission,
  _gitAdmissionSnapshotForTests,
  _resetGitAdmissionForTests
} from './command-runner/git-subprocess-admission'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-object-admission-'))
  const packs = join(root, 'objects', 'pack')
  await mkdir(packs, { recursive: true })
  await Promise.all(
    Array.from({ length: 50 }, (_, index) => writeFile(join(packs, `${index}.pack`), ''))
  )
  vi.clearAllMocks()
  _resetGitAdmissionForTests(new GitAdmissionScheduler())
})
afterEach(async () => {
  _resetGitAdmissionForTests()
  await rm(root, { recursive: true, force: true })
})

function args(controller: AbortController, canWrite = () => true) {
  return {
    repoPath: root,
    commonDir: root,
    signal: controller.signal,
    span: { setAttribute: () => {} },
    canWrite
  }
}

describe('object maintenance admission', () => {
  it('rechecks activity after queued admission without starting a repack', async () => {
    const blockers = await Promise.all(
      Array.from({ length: GENERAL_CAP }, () =>
        acquireGitAdmission({ args: ['status'], cwd: '/blocker', tier: 'background' })
      )
    )
    let busy = false
    try {
      const pending = maintainRepoObjects(args(new AbortController(), () => !busy))
      await vi.waitFor(() => expect(_gitAdmissionSnapshotForTests().queued).toBe(1))
      expect(await isGitWorktreeMutationInFlight(root, {})).toBe(false)
      busy = true
      blockers.forEach((blocker) => blocker.release())
      expect(await pending).toBe('deferred')
      expect(capture).not.toHaveBeenCalled()
      expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
    } finally {
      blockers.forEach((blocker) => blocker.release())
    }
  })

  it('keeps a live repack and its permit until process exit when activity resumes', async () => {
    let finish: (() => void) | undefined
    capture.mockImplementation(async (_binary, _argv, options) => {
      await new Promise<void>((resolve) => (finish = resolve))
      options.onChildTerminated?.()
      return { stdout: '', stderr: '' }
    })
    const controller = new AbortController()
    const pending = maintainRepoObjects(args(controller))
    try {
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      expect(await isGitWorktreeMutationInFlight(root, {})).toBe(false)
      controller.abort()
      expect(capture.mock.calls[0]?.[2].signal).toBeUndefined()
      expect(capture.mock.calls[0]?.[2].lowPriority).toBe(true)
      expect(capture.mock.calls[0]?.[1]).toEqual(
        process.platform === 'win32'
          ? [...OBJECT_MAINTENANCE_ARGS]
          : ['-n', '10', 'git', ...OBJECT_MAINTENANCE_ARGS]
      )
      expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(1)
      finish?.()
      expect(await pending).toBe('ran')
      expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
    } finally {
      finish?.()
      await pending
    }
  })
})
