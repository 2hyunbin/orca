import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalPtyAttachmentLifecycle } from './pty-renderer-delivery-claims'

const PTY_ID = 'workspace@@pty-1'

describe('local PTY attachment lifecycle (one record per connection generation)', () => {
  const openRendererAttachment = vi.fn()
  const updateRendererAttachment = vi.fn()
  const closeRendererAttachment = vi.fn()

  beforeEach(() => {
    openRendererAttachment.mockReset()
    updateRendererAttachment.mockReset()
    closeRendererAttachment.mockReset()
    vi.stubGlobal('window', {
      api: { pty: { openRendererAttachment, updateRendererAttachment, closeRendererAttachment } }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens the record with the spawn request and updates only that live record', () => {
    const attachments = createLocalPtyAttachmentLifecycle()
    const attempt = attachments.begin({ consuming: false, visible: false })
    // State before dispatch rides the spawn request itself.
    attachments.setDesired({ visible: true })
    const record = attachments.dispatch(attempt)
    expect(record).toMatchObject({ consuming: false, visible: true })
    expect(attachments.dispatch(attempt)).toBeUndefined()

    attachments.bind()
    attachments.finish(attempt)
    attachments.setDesired({ consuming: true })
    expect(updateRendererAttachment).toHaveBeenCalledWith(record!.key, { consuming: true })
    // An unchanged report is not resent unless a new restore handler announces itself.
    attachments.setDesired({ consuming: true })
    expect(updateRendererAttachment).toHaveBeenCalledTimes(1)
    attachments.setDesired({ consuming: true }, true)
    expect(updateRendererAttachment).toHaveBeenCalledTimes(2)

    attachments.release()
    expect(closeRendererAttachment).toHaveBeenCalledWith(record!.key)
  })

  it('a superseded or failed attempt can neither open nor outlive its connect', () => {
    const attachments = createLocalPtyAttachmentLifecycle()
    const stale = attachments.begin()
    const staleRecord = attachments.dispatch(stale)
    const fresh = attachments.begin()
    expect(closeRendererAttachment).toHaveBeenCalledWith(staleRecord!.key)
    expect(attachments.dispatch(stale)).toBeUndefined()

    // The stale connect settling late touches nothing of the newer attempt.
    attachments.finish(stale)
    const freshRecord = attachments.dispatch(fresh)
    expect(freshRecord).toBeDefined()
    expect(closeRendererAttachment).toHaveBeenCalledTimes(1)

    // A connect that fails before binding closes its own record.
    attachments.finish(fresh)
    expect(closeRendererAttachment).toHaveBeenLastCalledWith(freshRecord!.key)
  })

  it('a rejected reattach drops only the bound record, keeping a newer pending one', () => {
    const attachments = createLocalPtyAttachmentLifecycle()
    const first = attachments.begin()
    const firstRecord = attachments.dispatch(first)
    attachments.bind()
    attachments.finish(first)
    const second = attachments.begin()
    const secondRecord = attachments.dispatch(second)

    attachments.abandonBound()
    expect(closeRendererAttachment).toHaveBeenCalledExactlyOnceWith(firstRecord!.key)
    attachments.setDesired({ consuming: false })
    expect(updateRendererAttachment).toHaveBeenCalledExactlyOnceWith(secondRecord!.key, {
      consuming: false
    })
  })

  it('a known-id attach opens its own record bound to that id', () => {
    const attachments = createLocalPtyAttachmentLifecycle()
    attachments.setDesired({ visible: true })
    const attempt = attachments.begin()
    attachments.bind()
    attachments.finish(attempt, PTY_ID)
    expect(openRendererAttachment).toHaveBeenCalledWith(expect.any(String), PTY_ID, {
      consuming: true,
      visible: true
    })
  })
})
