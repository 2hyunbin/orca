import { recordTerminalFreezeBreadcrumb } from './terminal-freeze-breadcrumbs'

export type LocalPtyDeliveryState = { consuming: boolean; visible: boolean }

/**
 * One local transport connection's record in main. Main opens it from the spawn
 * request itself (or from a known-id attach), the connection's own reports update
 * it, and the connection's retirement closes it. Main alone aggregates records.
 */
type LocalPtyAttachment = LocalPtyDeliveryState & {
  readonly key: string
  opened: boolean
  closed: boolean
}

let nextAttachmentKey = 1

function ptyApi(): Window['api']['pty'] | undefined {
  return typeof window === 'undefined' ? undefined : window.api?.pty
}

function createLocalPtyAttachment(state: LocalPtyDeliveryState): LocalPtyAttachment {
  return { key: String(nextAttachmentKey++), ...state, opened: false, closed: false }
}

/** The spawn request carries the record, so main holds it before the provider can emit. */
function dispatchLocalPtyAttachment(
  attachment: LocalPtyAttachment
): ({ key: string } & LocalPtyDeliveryState) | undefined {
  if (attachment.opened || attachment.closed) {
    return undefined
  }
  attachment.opened = true
  return { key: attachment.key, consuming: attachment.consuming, visible: attachment.visible }
}

/** A known-id attach has no spawn request, so it opens its record bound to that id. */
function openLocalPtyAttachment(attachment: LocalPtyAttachment, ptyId: string): void {
  if (attachment.opened || attachment.closed) {
    return
  }
  attachment.opened = true
  const { consuming, visible } = attachment
  ptyApi()?.openRendererAttachment?.(attachment.key, ptyId, { consuming, visible })
}

/** `announce` re-sends an unchanged consuming state: a new restore handler must pull outstanding loss. */
function updateLocalPtyAttachment(
  attachment: LocalPtyAttachment,
  state: Partial<LocalPtyDeliveryState>,
  announce = false
): void {
  const changed: Partial<LocalPtyDeliveryState> = {}
  if (state.consuming !== undefined && (announce || state.consuming !== attachment.consuming)) {
    changed.consuming = state.consuming
  }
  if (state.visible !== undefined && state.visible !== attachment.visible) {
    changed.visible = state.visible
  }
  Object.assign(attachment, state)
  if (!attachment.opened || attachment.closed || Object.keys(changed).length === 0) {
    return
  }
  if (changed.consuming !== undefined) {
    recordTerminalFreezeBreadcrumb(
      changed.consuming ? 'renderer-gate-unmark' : 'renderer-gate-mark',
      { attachment: attachment.key }
    )
  }
  ptyApi()?.updateRendererAttachment?.(attachment.key, changed)
}

function closeLocalPtyAttachment(attachment: LocalPtyAttachment | null): void {
  if (!attachment || attachment.closed) {
    return
  }
  attachment.closed = true
  if (attachment.opened) {
    ptyApi()?.closeRendererAttachment?.(attachment.key)
  }
}

/**
 * One transport's attachments: at most one per connection generation. `pending`
 * is the in-flight connect's; `bound` belongs to the id the transport delivers.
 * Both live only while an old id still consumes and its replacement is pending.
 */
export function createLocalPtyAttachmentLifecycle() {
  let pending: LocalPtyAttachment | null = null
  let bound: LocalPtyAttachment | null = null
  const desired: LocalPtyDeliveryState = { consuming: true, visible: false }

  return {
    /** A new connect or attach generation supersedes the previous in-flight attempt. */
    begin(state: LocalPtyDeliveryState = desired): LocalPtyAttachment {
      closeLocalPtyAttachment(pending)
      pending = createLocalPtyAttachment(state)
      return pending
    },
    /** The transport now delivers this generation's id; the old id's handler stops consuming. */
    bind(): void {
      if (pending) {
        closeLocalPtyAttachment(bound)
        bound = pending
        pending = null
      }
    },
    /** The session rejected the bound result; a newer in-flight attempt keeps its own record. */
    abandonBound(): void {
      closeLocalPtyAttachment(bound)
      bound = null
    },
    /** Exit, disconnect, detach or destroy: this transport consumes nothing. */
    release(): void {
      closeLocalPtyAttachment(bound)
      closeLocalPtyAttachment(pending)
      bound = null
      pending = null
    },
    /** A connect or attach finished: an attempt it never bound ends here, whatever the outcome. */
    finish(attachment: LocalPtyAttachment, attachedPtyId?: string): void {
      if (pending === attachment) {
        closeLocalPtyAttachment(attachment)
        pending = null
      } else if (bound === attachment && attachedPtyId) {
        openLocalPtyAttachment(attachment, attachedPtyId)
      }
    },
    /** Spawn dispatch: only the generation's own live attempt opens a record. */
    dispatch(attachment: LocalPtyAttachment) {
      return pending === attachment ? dispatchLocalPtyAttachment(attachment) : undefined
    },
    setDesired(state: Partial<LocalPtyDeliveryState>, announce = false): void {
      Object.assign(desired, state)
      for (const attachment of [bound, pending]) {
        if (attachment) {
          updateLocalPtyAttachment(attachment, state, announce)
        }
      }
    }
  }
}
