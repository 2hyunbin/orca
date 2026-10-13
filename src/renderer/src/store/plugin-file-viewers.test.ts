import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  refreshPluginFileViewers,
  retainPluginFileViewerRegistry,
  usePluginFileViewerStore
} from './plugin-file-viewers'

const viewer = {
  key: 'viewer:community.viewer/sample',
  pluginKey: 'community.viewer',
  pluginName: 'Sample',
  id: 'sample',
  displayName: 'Sample viewer',
  revision: 'release-1',
  generation: 1,
  selector: [{ filenamePattern: '*.sample' }],
  rendering: 'host-ui',
  mode: 'readonly'
}
let releases: (() => void)[]
let changed: (() => void) | undefined
const stop = vi.fn()
const list = vi.fn()
const syntax = vi.fn()
const retain = (): void => {
  releases.push(retainPluginFileViewerRegistry())
}

beforeEach(() => {
  releases = []
  vi.clearAllMocks()
  changed = undefined
  list.mockResolvedValue([viewer])
  syntax.mockResolvedValue([])
  vi.stubGlobal('window', {
    api: {
      plugins: {
        listFileViewers: list,
        listSyntaxPacks: syntax,
        onChanged: (listener: () => void) => {
          changed = listener
          return stop
        }
      }
    }
  })
})
afterEach(() => {
  for (const release of releases) {
    release()
  }
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
describe('approved file-viewer metadata registry', () => {
  it('shares one metadata subscription and makes release idempotent', async () => {
    retain()
    retain()
    await refreshPluginFileViewers()
    expect(usePluginFileViewerStore.getState()).toMatchObject({
      status: 'ready',
      viewers: [viewer]
    })
    expect(list).toHaveBeenCalledTimes(2)
    releases[0]!()
    releases[0]!()
    expect(stop).not.toHaveBeenCalled()
    releases[1]!()
    expect(stop).toHaveBeenCalledOnce()
    expect(usePluginFileViewerStore.getState().status).toBe('idle')
  })
  it('withdraws cached metadata immediately and ignores a late stale response', async () => {
    retain()
    await refreshPluginFileViewers()
    let resolveOld: ((value: unknown) => void) | undefined
    list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        })
    )
    const old = refreshPluginFileViewers()
    expect(usePluginFileViewerStore.getState()).toMatchObject({ status: 'loading', viewers: [] })
    list.mockResolvedValue([])
    await refreshPluginFileViewers()
    resolveOld?.([viewer])
    await old
    expect(usePluginFileViewerStore.getState()).toMatchObject({ status: 'ready', viewers: [] })
  })
  it('refreshes on approval or disable changes without keeping withdrawn viewers', async () => {
    retain()
    await refreshPluginFileViewers()
    list.mockResolvedValue([])
    changed?.()
    expect(usePluginFileViewerStore.getState().viewers).toEqual([])
    await vi.waitFor(() => expect(usePluginFileViewerStore.getState().status).toBe('ready'))
    expect(usePluginFileViewerStore.getState().viewers).toEqual([])
  })
  it.each([
    null,
    [viewer, viewer],
    [{ ...viewer, key: 'viewer:another.owner/sample' }],
    Array.from({ length: 513 }, () => viewer)
  ])('fails closed on invalid, duplicate, unowned or excessive metadata: %#', async (value) => {
    list.mockResolvedValue(value)
    retain()
    await refreshPluginFileViewers()
    expect(usePluginFileViewerStore.getState()).toMatchObject({
      status: 'failed',
      viewers: [],
      syntaxPacks: []
    })
  })
  it('reaches a recoverable failure after the deadline and cannot resurrect a late reply', async () => {
    vi.useFakeTimers()
    let late: ((value: unknown) => void) | undefined
    list.mockImplementation(
      () =>
        new Promise((resolve) => {
          late = resolve
        })
    )
    retain()
    await vi.advanceTimersByTimeAsync(5000)
    expect(usePluginFileViewerStore.getState().status).toBe('failed')
    late?.([viewer])
    await Promise.resolve()
    expect(usePluginFileViewerStore.getState().status).toBe('failed')
    list.mockResolvedValue([viewer])
    await refreshPluginFileViewers()
    expect(usePluginFileViewerStore.getState().status).toBe('ready')
  })
  it('does not publish replies after the last reader closes', async () => {
    let finish: ((value: unknown) => void) | undefined
    list.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    retain()
    releases[0]!()
    finish?.([viewer])
    await Promise.resolve()
    await Promise.resolve()
    expect(usePluginFileViewerStore.getState()).toMatchObject({ status: 'idle', viewers: [] })
  })
  it('reports unsupported metadata APIs separately from an empty successful list', async () => {
    vi.stubGlobal('window', { api: { plugins: {} } })
    retain()
    await refreshPluginFileViewers()
    expect(usePluginFileViewerStore.getState().status).toBe('unsupported')
  })
})
