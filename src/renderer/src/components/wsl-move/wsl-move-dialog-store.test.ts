import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  WslMovePreview,
  WslMoveProgressEvent,
  WslMoveResult
} from '../../../../shared/wsl-move/wsl-move-driver-types'

const reload = vi.fn()
vi.mock('@/lib/lazy-chunk-recovery-reload', () => ({
  requestLazyChunkRecoveryReload: (...args: unknown[]) => reload(...args)
}))

const store = await import('./wsl-move-dialog-store')
const {
  cancelWslMove,
  closeWslMoveDialog,
  openWslMoveDialog,
  reloadAfterWslMove,
  reviewWslMoveAgain,
  setWslMoveSelection,
  skipWslMoveProjects,
  startWslMove,
  useWslMoveDialogStore
} = store

const READY: WslMovePreview = {
  outcome: 'ready',
  distro: 'Ubuntu',
  repoIds: ['api', 'web'],
  folderWorkspaceIds: ['notes'],
  changed: [],
  heldByHost: [],
  refused: [],
  blockers: []
}

type Api = {
  preview: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  listUnfinished: ReturnType<typeof vi.fn>
  onProgress: ReturnType<typeof vi.fn>
}

let api: Api
let emitProgress: (event: WslMoveProgressEvent) => void
const unsubscribe = vi.fn()

const dialog = () => useWslMoveDialogStore.getState().dialog

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  useWslMoveDialogStore.setState({ dialog: { stage: 'closed' }, unfinished: [] })
  emitProgress = () => undefined
  api = {
    preview: vi.fn(async () => READY),
    start: vi.fn(),
    cancel: vi.fn(async () => true),
    listUnfinished: vi.fn(async () => []),
    onProgress: vi.fn((listener: (event: WslMoveProgressEvent) => void) => {
      emitProgress = listener
      return unsubscribe
    })
  }
  vi.stubGlobal('window', { api: { wslMove: api } })
  reload.mockReset()
  unsubscribe.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('preview', () => {
  it('selects the whole distro by default and reuses its preview', async () => {
    await openWslMoveDialog({ distro: 'Ubuntu' })
    const state = dialog()
    expect(state.stage).toBe('preview')
    expect(state.stage === 'preview' && state.selected).toHaveLength(3)
    expect(state.stage === 'preview' && state.preview).toBe(READY)
    expect(api.preview).toHaveBeenCalledTimes(1)
    expect(api.preview).toHaveBeenCalledWith({ distro: 'Ubuntu' })
  })

  it('opened from one project, checks only it and previews that selection', async () => {
    await openWslMoveDialog({ distro: 'Ubuntu', only: { kind: 'repo', id: 'web' } })
    expect(api.preview).toHaveBeenLastCalledWith({
      distro: 'Ubuntu',
      repoIds: ['web'],
      folderWorkspaceIds: []
    })
    const state = dialog()
    expect(state.stage === 'preview' && state.selected).toEqual([{ kind: 'repo', id: 'web' }])
  })

  it('drops a stale preview reply when the selection changed meanwhile', async () => {
    await openWslMoveDialog({ distro: 'Ubuntu' })
    const slow = deferred<WslMovePreview>()
    api.preview.mockReturnValueOnce(slow.promise)
    setWslMoveSelection([{ kind: 'repo', id: 'api' }])
    const fresh: WslMovePreview = { ...READY, repoIds: ['web'] }
    api.preview.mockResolvedValueOnce(fresh)
    setWslMoveSelection([{ kind: 'repo', id: 'web' }])
    await vi.waitFor(() => {
      const state = dialog()
      expect(state.stage === 'preview' && state.preview).toBe(fresh)
    })
    slow.resolve(READY)
    await Promise.resolve()
    const state = dialog()
    expect(state.stage === 'preview' && state.preview).toBe(fresh)
  })

  it('skips the projects a blocker names', async () => {
    await openWslMoveDialog({ distro: 'Ubuntu' })
    skipWslMoveProjects([{ kind: 'repo', id: 'api' }])
    const state = dialog()
    expect(state.stage === 'preview' && state.selected).toEqual([
      { kind: 'repo', id: 'web' },
      { kind: 'folder', id: 'notes' }
    ])
  })

  it('lists catalog projects when a smaller selection may avoid the refusal', async () => {
    api.preview.mockResolvedValueOnce({
      outcome: 'refused',
      code: 'wsl_move_export_incomplete',
      reasons: ['1 draft can’t move with this project yet.']
    })
    await openWslMoveDialog({
      distro: 'Ubuntu',
      catalogCandidates: () => ({ repoIds: ['api'], folderWorkspaceIds: [] })
    })
    const state = dialog()
    expect(state.stage === 'preview' && state.candidates.repoIds).toEqual(['api'])
  })

  it('keeps no checkboxes for a refusal no selection can fix', async () => {
    api.preview.mockResolvedValueOnce({ outcome: 'refused', code: 'wsl_move_host_unavailable' })
    await openWslMoveDialog({
      distro: 'Ubuntu',
      catalogCandidates: () => ({ repoIds: ['api'], folderWorkspaceIds: [] })
    })
    const state = dialog()
    expect(state.stage === 'preview' && state.selected).toEqual([])
    expect(state.stage === 'preview' && state.preview?.outcome).toBe('refused')
  })

  it('turns a failed preview call into a refusal, never a stuck spinner', async () => {
    api.preview.mockRejectedValueOnce(new Error('ipc'))
    await openWslMoveDialog({ distro: 'Ubuntu' })
    const state = dialog()
    expect(state.stage === 'preview' && state.preview?.outcome).toBe('refused')
  })
})

describe('run', () => {
  it('follows progress for its distro, then shows the result and refreshes unfinished moves', async () => {
    await openWslMoveDialog({ distro: 'Ubuntu' })
    const run = deferred<WslMoveResult>()
    api.start.mockReturnValueOnce(run.promise)
    const started = startWslMove()
    expect(dialog().stage).toBe('running')
    emitProgress({ distro: 'Debian', step: 'switching' })
    emitProgress({ distro: 'Ubuntu', step: 'copying', bytesSent: 5, bytesTotal: 10 })
    const running = dialog()
    expect(running.stage === 'running' && running.progress?.step).toBe('copying')
    run.resolve({
      outcome: 'moved',
      migrationId: 'm1',
      phase: 'retained',
      reloadRequired: true,
      automationsPending: ['a1']
    })
    await started
    expect(unsubscribe).toHaveBeenCalled()
    const result = dialog()
    expect(result.stage === 'result' && result.result.outcome).toBe('moved')
    expect(api.listUnfinished).toHaveBeenCalled()
  })

  it('cannot be closed or replaced while running, nor before a moved window reloads', async () => {
    await openWslMoveDialog({ distro: 'Ubuntu' })
    const run = deferred<WslMoveResult>()
    api.start.mockReturnValueOnce(run.promise)
    const started = startWslMove()
    closeWslMoveDialog()
    await openWslMoveDialog({ distro: 'Debian' })
    expect(dialog().stage).toBe('running')
    run.resolve({ outcome: 'moved', migrationId: 'm1', phase: 'retained', reloadRequired: true })
    await started
    closeWslMoveDialog()
    expect(dialog().stage).toBe('result')
  })

  it('reports a cancel that came too late', async () => {
    await openWslMoveDialog({ distro: 'Ubuntu' })
    const run = deferred<WslMoveResult>()
    api.start.mockReturnValueOnce(run.promise)
    void startWslMove()
    api.cancel.mockResolvedValueOnce(false)
    await cancelWslMove()
    const state = dialog()
    expect(state.stage === 'running' && state.cancel).toBe('too-late')
    expect(api.cancel).toHaveBeenCalledWith('Ubuntu')
  })

  it('turns a failed start call into a refusal', async () => {
    await openWslMoveDialog({ distro: 'Ubuntu' })
    api.start.mockRejectedValueOnce(new Error('ipc'))
    await startWslMove()
    const state = dialog()
    expect(state.stage === 'result' && state.result.outcome).toBe('refused')
    closeWslMoveDialog()
    expect(dialog().stage).toBe('closed')
  })

  it('reloads through restart preparation and shows a refused reload', async () => {
    await openWslMoveDialog({ distro: 'Ubuntu' })
    api.start.mockResolvedValueOnce({
      outcome: 'refused',
      code: 'wsl_move_finished_earlier_move'
    })
    await startWslMove()
    reload.mockResolvedValueOnce('checkpoint-refused')
    await reloadAfterWslMove()
    expect(reload).toHaveBeenCalledTimes(1)
    const state = dialog()
    expect(state.stage === 'result' && state.reload).toBe('checkpoint-refused')
  })

  it('goes back to the same projects after a refusal', async () => {
    await openWslMoveDialog({ distro: 'Ubuntu' })
    setWslMoveSelection([
      { kind: 'repo', id: 'api' },
      { kind: 'folder', id: 'notes' }
    ])
    await vi.waitFor(() => expect(dialog().stage === 'preview').toBe(true))
    api.start.mockResolvedValueOnce({ outcome: 'refused', code: 'wsl_move_scope_changed' })
    await startWslMove()
    await reviewWslMoveAgain()
    const state = dialog()
    expect(state.stage === 'preview' && state.selected).toEqual([
      { kind: 'repo', id: 'api' },
      { kind: 'folder', id: 'notes' }
    ])
  })
})
