import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'

class GraphRuntime extends OrcaRuntimeService {
  get graph() {
    return this.runtimeGraphState
  }
}

const graph = {
  tabs: [{ tabId: 'tab', worktreeId: 'workspace', activeLeafId: 'leaf', layout: null, title: '' }],
  leaves: [
    {
      tabId: 'tab',
      worktreeId: 'workspace',
      leafId: 'leaf',
      paneRuntimeId: 1,
      ptyId: 'pty',
      paneTitle: null
    }
  ]
}

describe('runtime graph ownership', () => {
  it('shares detached preallocated leaves with terminal identity during renderer reload', async () => {
    const runtime = new GraphRuntime()
    const handle = runtime.preAllocateHandleForPty('pty')
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, graph)
    const leaf = runtime.graph.leaves.get('tab::leaf')

    runtime.markRendererReloading(1)

    expect(runtime.graph.detachedPreAllocatedLeaves.get('pty')).toBe(leaf)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.onPtyData('pty', 'after omitted leaf\n', 100)
    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({
      tail: ['after omitted leaf']
    })
  })

  it('keeps the installed graph and its PTY index in one per-runtime authority', () => {
    const first = new GraphRuntime()
    const second = new GraphRuntime()
    first.attachWindow(1)
    first.syncWindowGraph(1, graph)
    const leaf = first.graph.leavesByPtyId.get('pty')?.[0]
    expect(leaf).toBe(first.graph.leaves.get('tab::leaf'))
    expect(first.graph.leavesByPtyId.has('pty')).toBe(true)
    expect(second.graph.leavesByPtyId.has('pty')).toBe(false)
    expect(second.graph.graphStatus).toBe('unavailable')

    first.markGraphUnavailable(1)
    expect(first.graph.tabs.size).toBe(0)
    expect(first.graph.leaves.size).toBe(0)
    expect(first.graph.leavesByPtyId.has('pty')).toBe(false)
    expect(second.graph.rendererGraphEpoch).toBe(0)
  })

  it('drains the captured callback list when a callback changes registration', () => {
    const runtime = new GraphRuntime()
    runtime.attachWindow(1)
    const later = vi.fn()
    const original = vi.fn()
    runtime.graph.graphSyncCallbacks.push(() => {
      runtime.graph.graphSyncCallbacks.splice(1, 1)
      runtime.graph.graphSyncCallbacks.push(later)
    }, original)

    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    expect(original).toHaveBeenCalledOnce()
    expect(later).not.toHaveBeenCalled()
  })
})
