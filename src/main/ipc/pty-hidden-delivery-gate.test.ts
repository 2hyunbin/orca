import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetHiddenRendererPtyDeliveryGateForTest,
  clearHiddenRendererPtyDeliveryState,
  consumeHiddenRendererPtyDropMemory,
  getHiddenRendererPtyDeliveryDebug,
  isHiddenPtyDeliveryGateEnabled,
  rearmHiddenRendererPtyRestore,
  recordHiddenRendererPtyDataDrop,
  setRendererPtyDeliveryInterest,
  shouldDropRendererPtyData
} from './pty-hidden-delivery-gate'
import {
  closeRendererAttachment,
  deleteRendererAttachmentsForPage,
  openRendererAttachment,
  unbindRendererAttachmentsForPty,
  updateRendererAttachment
} from './pty/delivery/renderer-attachments'

const PTY_ID = 'pty-1'
const PAGE = 'page-1'

function attach(key: string, ptyId: string | null, consuming: boolean) {
  return openRendererAttachment(PAGE, key, ptyId, { consuming, visible: consuming })
}

describe('pty hidden delivery gate', () => {
  beforeEach(() => {
    _resetHiddenRendererPtyDeliveryGateForTest()
  })

  it('only operates when both kill switches are on (default on)', () => {
    expect(isHiddenPtyDeliveryGateEnabled(undefined)).toBe(true)
    expect(isHiddenPtyDeliveryGateEnabled({})).toBe(true)
    expect(isHiddenPtyDeliveryGateEnabled({ terminalHiddenDeliveryGate: false })).toBe(false)
    expect(isHiddenPtyDeliveryGateEnabled({ terminalMainSideEffectAuthority: false })).toBe(false)
  })

  it('delivers only while a consuming connection or raw interest holds the PTY', () => {
    // No connection consumes: main answers and drops.
    expect(shouldDropRendererPtyData(PTY_ID, {})).toBe(true)
    expect(shouldDropRendererPtyData(PTY_ID, { terminalHiddenDeliveryGate: false })).toBe(false)

    attach('a', PTY_ID, true)
    expect(shouldDropRendererPtyData(PTY_ID, {})).toBe(false)
    updateRendererAttachment(PAGE, 'a', { consuming: false })
    expect(shouldDropRendererPtyData(PTY_ID, {})).toBe(true)

    setRendererPtyDeliveryInterest(PTY_ID, true, 'test-page')
    expect(shouldDropRendererPtyData(PTY_ID, {})).toBe(false)
    setRendererPtyDeliveryInterest(PTY_ID, false, 'test-page')
    expect(shouldDropRendererPtyData(PTY_ID, {})).toBe(true)
  })

  it('a stale connection handle can neither hold nor rebind a PTY once closed', () => {
    const stale = attach('a', null, true)
    closeRendererAttachment(PAGE, 'a')
    stale.bind(PTY_ID)
    expect(shouldDropRendererPtyData(PTY_ID, {})).toBe(true)

    // A newer record reusing the key is not the stale handle's record.
    attach('a', null, true)
    stale.release()
    expect(updateRendererAttachment(PAGE, 'a', {})).toBeNull()
  })

  it('a retired page releases every connection it opened; PTY teardown keeps the record unbound', () => {
    const binding = attach('a', PTY_ID, true)
    unbindRendererAttachmentsForPty(PTY_ID)
    expect(shouldDropRendererPtyData(PTY_ID, {})).toBe(true)
    // Dead-owner replacement binds the same live connection to the new PTY.
    binding.bind('pty-2')
    expect(shouldDropRendererPtyData('pty-2', {})).toBe(false)

    deleteRendererAttachmentsForPage(PAGE)
    expect(shouldDropRendererPtyData('pty-2', {})).toBe(true)
  })

  it('requests the restore marker exactly once per drop episode, re-armed by the applied ack', () => {
    const drop = recordHiddenRendererPtyDataDrop(PTY_ID, 10)
    expect(drop.shouldEmitRestoreMarker).toBe(true)
    expect(recordHiddenRendererPtyDataDrop(PTY_ID, 10).shouldEmitRestoreMarker).toBe(false)

    // An ack before any consuming view belongs to an earlier restore and retires nothing.
    consumeHiddenRendererPtyDropMemory(PTY_ID, drop.hiddenDropEpisode)
    expect(recordHiddenRendererPtyDataDrop(PTY_ID, 10).shouldEmitRestoreMarker).toBe(false)

    // A consuming view painted the snapshot: the next episode reports again.
    expect(rearmHiddenRendererPtyRestore(PTY_ID)).toBe(drop.hiddenDropEpisode)
    consumeHiddenRendererPtyDropMemory(PTY_ID, drop.hiddenDropEpisode)
    expect(rearmHiddenRendererPtyRestore(PTY_ID)).toBeUndefined()
    expect(recordHiddenRendererPtyDataDrop(PTY_ID, 10).shouldEmitRestoreMarker).toBe(true)
  })

  it('a drop after the reveal survives the in-flight restore ack and re-emits its marker', () => {
    const first = recordHiddenRendererPtyDataDrop(PTY_ID, 10).hiddenDropEpisode
    expect(rearmHiddenRendererPtyRestore(PTY_ID)).toBe(first)

    // The user switches away again before the reveal's snapshot is painted.
    const second = recordHiddenRendererPtyDataDrop(PTY_ID, 10)
    expect(second.shouldEmitRestoreMarker).toBe(true)
    expect(second.hiddenDropEpisode).not.toBe(first)
    expect(recordHiddenRendererPtyDataDrop(PTY_ID, 10).shouldEmitRestoreMarker).toBe(false)
    // That snapshot may predate the new drop, so its ack must not retire the latch.
    consumeHiddenRendererPtyDropMemory(PTY_ID, first)
    expect(rearmHiddenRendererPtyRestore(PTY_ID)).toBe(second.hiddenDropEpisode)
    consumeHiddenRendererPtyDropMemory(PTY_ID, first)
    expect(rearmHiddenRendererPtyRestore(PTY_ID)).toBe(second.hiddenDropEpisode)

    consumeHiddenRendererPtyDropMemory(PTY_ID, second.hiddenDropEpisode)
    expect(rearmHiddenRendererPtyRestore(PTY_ID)).toBeUndefined()
  })

  it('clears all per-PTY state on teardown and tracks debug counters', () => {
    setRendererPtyDeliveryInterest('pty-2', true, 'test-page')
    recordHiddenRendererPtyDataDrop(PTY_ID, 7)
    recordHiddenRendererPtyDataDrop(PTY_ID, 5)

    expect(getHiddenRendererPtyDeliveryDebug()).toEqual({
      deliveryInterestPtyCount: 1,
      hiddenDeliveryDroppedChars: 12,
      hiddenDeliveryDroppedChunks: 2
    })

    clearHiddenRendererPtyDeliveryState(PTY_ID)
    clearHiddenRendererPtyDeliveryState('pty-2')
    expect(getHiddenRendererPtyDeliveryDebug()).toMatchObject({ deliveryInterestPtyCount: 0 })
    expect(rearmHiddenRendererPtyRestore(PTY_ID)).toBeUndefined()
  })
})
