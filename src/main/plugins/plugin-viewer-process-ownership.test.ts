import { describe, expect, it, vi } from 'vitest'
import {
  capturePluginViewerProcessOwners,
  exclusivePluginViewerFrames
} from './plugin-viewer-process-ownership'

const native = vi.hoisted(() => ({ all: vi.fn(), owner: vi.fn() }))
vi.mock('electron', () => ({
  app: {},
  webContents: { getAllWebContents: native.all, fromFrame: native.owner }
}))

describe('native viewer frame ownership census', () => {
  it('attributes embedded guest frames to their actual owner instead of the ancestor window', () => {
    const hostFrame = { frameTreeNodeId: 1, processId: 10, osProcessId: 100 }
    const guestFrame = { frameTreeNodeId: 2, processId: 20, osProcessId: 200 }
    const childFrame = { frameTreeNodeId: 3, processId: 30, osProcessId: 300 }
    const host = {
      id: 1,
      isDestroyed: () => false,
      mainFrame: { framesInSubtree: [hostFrame, guestFrame, childFrame] }
    }
    const guest = {
      id: 2,
      isDestroyed: () => false,
      mainFrame: { framesInSubtree: [guestFrame, childFrame] }
    }
    native.all.mockReturnValue([host, guest])
    native.owner.mockImplementation((frame) => (frame === hostFrame ? host : guest))
    const owners = capturePluginViewerProcessOwners()
    expect(owners[0].frames.map((frame) => frame.pid)).toEqual([100])
    expect(owners[1].frames.map((frame) => frame.pid)).toEqual([200, 300])
    expect(exclusivePluginViewerFrames(2, owners)?.map((frame) => frame.pid)).toEqual([200, 300])
    childFrame.osProcessId = 100
    expect(exclusivePluginViewerFrames(2, capturePluginViewerProcessOwners())).toBe(null)
    native.owner.mockReturnValue(undefined)
    expect(exclusivePluginViewerFrames(2, capturePluginViewerProcessOwners())).toBe(null)
  })
})
