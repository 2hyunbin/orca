// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithVisibleSnapshotPreview } from './orca-runtime-visible-snapshot-preview'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'

import type { OrchestrationCompatibilitySshAttachmentAuthority } from './runtime-terminal-contracts'
import { randomUUID } from 'node:crypto'

export class OrcaRuntimeWithSerializeHeadlessTerminalBuffer extends OrcaRuntimeWithVisibleSnapshotPreview {
  protected serializeHeadlessTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number; includeEmpty?: boolean } = {}
  ): Promise<{
    data: string
    cols: number
    rows: number
    cwd?: string | null
    lastTitle?: string
    seq?: number
    source?: 'headless'
    oscLinks?: TerminalOscLinkRange[]
    alternateScreen?: boolean
    scrollbackAnsi?: string
    kittyKeyboardFlags?: number
    terminalOwner?: 'shell'
    // Why: dangling mid-escape tail the restorer must write LAST, after any
    // reset, so the next live chunk completes it instead of rendering it
    // literally (Bug E / #7329).
    pendingEscapeTailAnsi?: string
  } | null> {
    return this.terminalOutput.serializeHeadlessTerminalBuffer(ptyId, opts)
  }

  protected disposeHeadlessTerminal(ptyId: string): void {
    return this.terminalOutput.disposeHeadlessTerminal(ptyId)
  }

  resolveLeafForHandle(handle: string): { ptyId: string | null } | null {
    const record = this.handles.get(handle)
    if (!record) {
      return null
    }
    if (record.tabId.startsWith('pty:')) {
      return { ptyId: record.ptyId }
    }
    const leaf = this.leaves.get(this.getLeafKey(record.tabId, record.leafId))
    if (!leaf) {
      return null
    }
    return { ptyId: leaf.ptyId }
  }

  // Why: remote clients hold handles across transport reconnects. A handle
  // minted for a concrete PTY must never silently adopt a different PTY that
  // later occupies the same pane — that misroutes keystrokes (#7718). Handles
  // still awaiting their first PTY (ptyId null) may adopt it, which preserves
  // the mobile pre-spawn subscribe flow.
  resolveLiveLeafForHandle(handle: string): { ptyId: string | null } | null {
    // Why the discarded call: it re-links a runtime-owned handle whose `handles` record a renderer
    // reload cleared, so the lookup below sees it; without it a phone's held handle inspects nothing.
    this.getLivePtyForHandle(handle)
    const record = this.handles.get(handle)
    if (!record) {
      return null
    }
    if (record.tabId.startsWith('pty:')) {
      return { ptyId: record.ptyId }
    }
    const leaf = this.leaves.get(this.getLeafKey(record.tabId, record.leafId))
    if (!leaf) {
      return null
    }
    if (
      record.ptyId !== null &&
      (leaf.ptyId !== record.ptyId || leaf.ptyGeneration !== record.ptyGeneration)
    ) {
      throw new Error('terminal_handle_stale')
    }
    return { ptyId: leaf.ptyId }
  }

  getOrchestrationCompatibilityHostId(): 'local' {
    return 'local'
  }

  registerOrchestrationCompatibilitySshAttachment(
    targetId: string,
    connectionIncarnation: string
  ): OrchestrationCompatibilitySshAttachmentAuthority {
    const authority = Object.freeze({
      kind: 'ssh' as const,
      targetId,
      connectionIncarnation,
      attachmentId: randomUUID()
    })
    this.orchestrationCompatibilitySshAttachments.set(authority.attachmentId, authority)
    return authority
  }

  releaseOrchestrationCompatibilitySshAttachment(attachmentId: string): void {
    this.orchestrationCompatibilitySshAttachments.delete(attachmentId)
  }
}
