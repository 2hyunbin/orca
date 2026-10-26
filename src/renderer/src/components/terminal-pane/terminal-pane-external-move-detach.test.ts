import { describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { detachExternallyMovedPane } from './terminal-pane-external-move-detach'

const SOURCE = 'web-terminal-source'
const TARGET = 'web-terminal-target'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PTY = 'remote:env@@term-1'

function detach(detached = true): ReturnType<typeof vi.fn> {
  const transfer = vi.fn()
  detachExternallyMovedPane({
    manager: { getLeafId: () => LEAF, detachPaneForExternalMove: () => detached },
    paneId: 2,
    tabId: SOURCE,
    movedTo: { tabId: TARGET, leafId: LEAF },
    ptyId: PTY,
    transferAgentPaneAuthority: transfer
  })
  return transfer
}

describe('detachExternallyMovedPane', () => {
  it('hands the source pane’s agent records to the pane in its new tab', () => {
    expect(detach()).toHaveBeenCalledWith({
      fromPaneKey: makePaneKey(SOURCE, LEAF),
      toPaneKey: makePaneKey(TARGET, LEAF),
      ptyId: PTY
    })
  })

  it('leaves the records alone when the pane could not be detached', () => {
    expect(detach(false)).not.toHaveBeenCalled()
  })
})
