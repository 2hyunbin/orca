import { describe, expect, it, vi } from 'vitest'
import { findCursorInteractiveElements } from './snapshot-cursor-interactive-elements'
import type { CdpCommandSender } from './snapshot-engine'

function createSnapshotSender(
  options: {
    elements?: number
    malformedQuery?: boolean
    failQuery?: boolean
    failDescription?: boolean
    failCleanup?: boolean
    failRelease?: boolean
  } = {}
): {
  sender: CdpCommandSender
  retainedHandleCount: () => number
  peakHandleCount: () => number
  releasedGroups: string[]
  temporaryArrayPresent: () => boolean
} {
  const handlesByGroup = new Map<string, Set<string>>()
  const releasedGroups: string[] = []
  let temporaryArrayPresent = false
  let peak = 0
  const retainedHandleCount = (): number =>
    [...handlesByGroup.values()].reduce((total, handles) => total + handles.size, 0)
  const sender: CdpCommandSender = vi.fn(async (method, params) => {
    if (method === 'Runtime.releaseObjectGroup') {
      if (options.failRelease) {
        throw new Error('Debugger detached')
      }
      const group = params?.objectGroup
      if (typeof group !== 'string') {
        throw new Error('Missing object group')
      }
      releasedGroups.push(group)
      handlesByGroup.delete(group)
      return {}
    }
    if (method === 'Runtime.evaluate') {
      const expression = params?.expression
      if (expression === 'delete window.__orcaCursorInteractive') {
        if (options.failCleanup) {
          throw new Error('Context unavailable')
        }
        temporaryArrayPresent = false
        return { result: { value: true } }
      }
      if (
        typeof expression === 'string' &&
        expression.startsWith('window.__orcaCursorInteractive[')
      ) {
        const index = expression.match(/\[(\d+)\]/)?.[1]
        const objectId = `element-${index}`
        const group = typeof params?.objectGroup === 'string' ? params.objectGroup : 'unreleased'
        let handles = handlesByGroup.get(group)
        if (!handles) {
          handles = new Set()
          handlesByGroup.set(group, handles)
        }
        handles.add(objectId)
        peak = Math.max(peak, retainedHandleCount())
        return { result: { objectId } }
      }
      if (options.failQuery) {
        throw new Error('Query rejected')
      }
      temporaryArrayPresent = true
      return {
        result: {
          value: options.malformedQuery
            ? 'invalid-json'
            : JSON.stringify(
                Array.from({ length: options.elements ?? 2 }, (_, index) => ({
                  text: `Control ${index}`,
                  tag: 'div'
                }))
              )
        }
      }
    }
    if (method === 'DOM.describeNode') {
      if (options.failDescription) {
        throw new Error('Element removed')
      }
      const objectId = params?.objectId
      if (typeof objectId !== 'string') {
        throw new Error('Missing object id')
      }
      return { node: { backendNodeId: Number(objectId.replace('element-', '')) + 10 } }
    }
    throw new Error(`Unexpected method ${method}`)
  })
  return {
    sender,
    retainedHandleCount,
    peakHandleCount: () => peak,
    releasedGroups,
    temporaryArrayPresent: () => temporaryArrayPresent
  }
}

describe('cursor interactive snapshot ownership', () => {
  it('releases all temporary handles after repeated snapshots while preserving backend references', async () => {
    const rig = createSnapshotSender({ elements: 50 })
    for (let cycle = 0; cycle < 100; cycle++) {
      const entries = await findCursorInteractiveElements(rig.sender, [])
      expect(entries).toHaveLength(50)
      expect(entries[0]).toEqual({
        ref: '',
        role: 'clickable',
        name: 'Control 0',
        backendDOMNodeId: 10,
        depth: 0
      })
      expect(rig.retainedHandleCount()).toBe(0)
      expect(rig.temporaryArrayPresent()).toBe(false)
    }
    expect(rig.peakHandleCount()).toBe(50)
    expect(new Set(rig.releasedGroups).size).toBe(100)
  })

  it('releases handles for entries already represented by the accessibility tree', async () => {
    const rig = createSnapshotSender()
    const entries = await findCursorInteractiveElements(rig.sender, [
      { ref: '@e1', role: 'button', name: 'Existing', backendDOMNodeId: 10, depth: 0 }
    ])
    expect(entries.map((entry) => entry.backendDOMNodeId)).toEqual([11])
    expect(rig.retainedHandleCount()).toBe(0)
  })

  it('releases handles when a node disappears before it can be described', async () => {
    const rig = createSnapshotSender({ failDescription: true })
    expect(await findCursorInteractiveElements(rig.sender, [])).toEqual([])
    expect(rig.retainedHandleCount()).toBe(0)
    expect(rig.temporaryArrayPresent()).toBe(false)
  })

  it('removes the temporary array even when parsing the query result fails', async () => {
    const rig = createSnapshotSender({ malformedQuery: true })
    expect(await findCursorInteractiveElements(rig.sender, [])).toEqual([])
    expect(rig.temporaryArrayPresent()).toBe(false)
  })

  it('still releases handles when deleting the temporary array fails', async () => {
    const rig = createSnapshotSender({ failCleanup: true })
    expect(await findCursorInteractiveElements(rig.sender, [])).toHaveLength(2)
    expect(rig.retainedHandleCount()).toBe(0)
  })

  it('does not issue a release command when the query creates no handles', async () => {
    const rig = createSnapshotSender({ elements: 0 })
    expect(await findCursorInteractiveElements(rig.sender, [])).toEqual([])
    expect(rig.releasedGroups).toEqual([])
  })

  it('keeps overlapping snapshots in separate temporary object groups', async () => {
    const rig = createSnapshotSender({ elements: 50 })
    const entries = await Promise.all([
      findCursorInteractiveElements(rig.sender, []),
      findCursorInteractiveElements(rig.sender, [])
    ])
    expect(entries.map((snapshot) => snapshot.length)).toEqual([50, 50])
    expect(rig.peakHandleCount()).toBe(100)
    expect(rig.retainedHandleCount()).toBe(0)
    expect(new Set(rig.releasedGroups).size).toBe(2)
  })

  it('preserves snapshot entries when group cleanup is rejected after a detach', async () => {
    const rig = createSnapshotSender({ failRelease: true })
    expect(await findCursorInteractiveElements(rig.sender, [])).toHaveLength(2)
    expect(rig.temporaryArrayPresent()).toBe(false)
  })

  it('still releases handles when a destroyed context throws synchronously during array cleanup', async () => {
    const rig = createSnapshotSender()
    const sender: CdpCommandSender = (method, params) => {
      if (
        method === 'Runtime.evaluate' &&
        params?.expression === 'delete window.__orcaCursorInteractive'
      ) {
        throw new Error('Context destroyed')
      }
      return rig.sender(method, params)
    }
    expect(await findCursorInteractiveElements(sender, [])).toHaveLength(2)
    expect(rig.retainedHandleCount()).toBe(0)
  })

  it('preserves entries when a destroyed debugger throws synchronously during group cleanup', async () => {
    const rig = createSnapshotSender()
    const sender: CdpCommandSender = (method, params) => {
      if (method === 'Runtime.releaseObjectGroup') {
        throw new Error('Debugger destroyed')
      }
      return rig.sender(method, params)
    }
    expect(await findCursorInteractiveElements(sender, [])).toHaveLength(2)
    expect(rig.temporaryArrayPresent()).toBe(false)
  })

  it('does not start more commands after the initial query is rejected', async () => {
    const rig = createSnapshotSender({ failQuery: true })
    expect(await findCursorInteractiveElements(rig.sender, [])).toEqual([])
    expect(rig.sender).toHaveBeenCalledTimes(1)
    expect(rig.temporaryArrayPresent()).toBe(false)
  })

  it('releases handles without waiting for stalled array cleanup', async () => {
    const rig = createSnapshotSender()
    let finishDeletion = (): void => {}
    const deletion = new Promise<void>((resolve) => {
      finishDeletion = resolve
    })
    const sender: CdpCommandSender = (method, params) => {
      if (
        method === 'Runtime.evaluate' &&
        params?.expression === 'delete window.__orcaCursorInteractive'
      ) {
        return deletion
      }
      return rig.sender(method, params)
    }
    const snapshot = findCursorInteractiveElements(sender, [])
    try {
      await vi.waitFor(
        () => {
          expect(rig.releasedGroups).toHaveLength(1)
          expect(rig.retainedHandleCount()).toBe(0)
        },
        { timeout: 1_000, interval: 10 }
      )
    } finally {
      finishDeletion()
    }
    expect(await snapshot).toHaveLength(2)
  })
})
