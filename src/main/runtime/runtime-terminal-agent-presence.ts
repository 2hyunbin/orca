import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess,
  recognizeAgentProcess
} from '../../shared/agent-process-recognition'
import { isOpenCodeNativeTitle } from '../../shared/agent-detection'
import { isShellProcess } from '../../shared/shell-process-detection'
import { isKnownReadyPromptPreview } from './terminal-wait-detection'
import { buildTerminalWaitText } from './terminal-wait-tail-state'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import {
  agentTitleProvesAgentPresence,
  classifyAgentTitle,
  classifyLatestAgentTitle,
  getLatestAgentCandidateTitle,
  getLatestLeafTitle,
  getLeafDisplayRecord,
  getPtyDisplayRecord,
  ptyTitleProvesAgentPresence,
  type TitleDisplayClear
} from './runtime-worktree-status-projection'

const WRAPPER_RETRY_INTERVAL_MS = 150
const WRAPPER_RETRY_TIMEOUT_MS = 6_500

/** `unknown`: nothing shows an agent and the foreground process could not be read. */
export type TerminalAgentPresence = 'present' | 'absent' | 'unknown'

type RuntimeTerminalAgentPresenceDependencies = {
  /** A structured agent session of this runtime; it has no pane, so no PTY probe can see it. */
  isLiveStructuredAgent?(handle: string): boolean
  getLivePty(handle: string): RuntimePtyWorktreeRecord | null
  getLiveLeaf(handle: string): RuntimeLeafRecord
  getPrimaryLeaf(ptyId: string): RuntimeLeafRecord | null
  getTrackedPty(ptyId: string): RuntimePtyWorktreeRecord | null
  getTabTitle(tabId: string): string | null
  getForegroundProcess(ptyId: string): Promise<string | null> | null
  confirmForegroundProcess(ptyId: string): Promise<string | null> | null
  /** The agent's own live account of itself: OSC 7501 activity or a fresh hook status row. */
  reportsAgentStatus(handle: string, ptyId: string): boolean
  /** The stale-working timer's display-only clear of the PTY's own title, if one stands. */
  getTitleDisplayClear(ptyId: string): TitleDisplayClear | null
}

export type RuntimeTerminalAgentPresenceOptions = {
  retryForegroundWrappers?: boolean
  /** Foreground identity the caller already confirmed; skips the provider's cached read. */
  foregroundProcess?: string | null
}

type PaneAgentEvidence = {
  ptyId: string | null
  /** A title or prompt that only an agent paints. */
  shown: boolean
  /** An agent status recorded with no title to contradict it. */
  untitledStatus: boolean
  /** Claude's management screen is up, so a Claude process there is not a task agent. */
  suppressClaude: boolean
}

export class RuntimeTerminalAgentPresence {
  constructor(private readonly deps: RuntimeTerminalAgentPresenceDependencies) {}

  async isRunning(
    handle: string,
    options: RuntimeTerminalAgentPresenceOptions = {}
  ): Promise<boolean> {
    return (await this.resolve(handle, options)) === 'present'
  }

  async resolve(
    handle: string,
    options: RuntimeTerminalAgentPresenceOptions = {}
  ): Promise<TerminalAgentPresence> {
    // Why: a structured session IS the agent and has no pane or foreground process to probe.
    if (this.deps.isLiveStructuredAgent?.(handle)) {
      return 'present'
    }
    try {
      const pane = this.readPaneEvidence(handle)
      if (pane.shown) {
        return 'present'
      }
      if (!pane.ptyId) {
        return pane.untitledStatus ? 'present' : 'absent'
      }
      // Why: under OSC 7501 an agent paints no title glyph, so its own status is the evidence;
      // it counts only where the process read below does not contradict it.
      const reported =
        !pane.suppressClaude &&
        (pane.untitledStatus || this.deps.reportsAgentStatus(handle, pane.ptyId))
      const foreground = await this.readForegroundProcess(pane.ptyId, {
        confirmShell: reported,
        cached: options.foregroundProcess
      })
      if (!foreground) {
        return reported ? 'present' : 'unknown'
      }
      const recognized = recognizeAgentProcess(foreground)
      if (recognized) {
        return pane.suppressClaude && isExpectedAgentProcess(recognized.processName, 'claude')
          ? 'absent'
          : 'present'
      }
      if (isShellProcess(foreground)) {
        return 'absent'
      }
      if (reported) {
        return 'present'
      }
      return options.retryForegroundWrappers !== false &&
        isAgentForegroundWrapperProcess(foreground) &&
        (await this.waitForWrappedAgent(pane.ptyId, pane.suppressClaude))
        ? 'present'
        : 'absent'
    } catch {
      return 'absent'
    }
  }

  /**
   * The foreground's name, re-read once from the launch command line when the cached name proves
   * nothing: macOS p_comm names the native Claude install by its version directory (`2.1.310`),
   * and a Windows tracker answers with the shell until its scan lands.
   */
  async readForegroundProcess(
    ptyId: string,
    { confirmShell, cached }: { confirmShell: boolean; cached?: string | null }
  ): Promise<string | null> {
    const foreground =
      cached !== undefined
        ? cached
        : await Promise.resolve(this.deps.getForegroundProcess(ptyId)).catch(() => null)
    if (
      !foreground ||
      recognizeAgentProcess(foreground) ||
      isAgentForegroundWrapperProcess(foreground) ||
      (!confirmShell && isShellProcess(foreground))
    ) {
      return foreground
    }
    const confirmed = await Promise.resolve(this.deps.confirmForegroundProcess(ptyId)).catch(
      () => null
    )
    return confirmed ?? foreground
  }

  private readPaneEvidence(handle: string): PaneAgentEvidence {
    // Why display records: presence reads what the pane shows, as before the stale-working
    // clear stopped rewriting records. A cwd spinner clears to a neutral title, so the
    // foreground process decides for an agent that exited behind it.
    const pty = this.deps.getLivePty(handle)
    if (pty) {
      const clear = this.deps.getTitleDisplayClear(pty.ptyId)
      const leaf = this.deps.getPrimaryLeaf(pty.ptyId)
      return readPtyEvidence(
        getPtyDisplayRecord(pty, clear),
        leaf ? getLeafDisplayRecord(leaf, clear) : null
      )
    }
    const liveLeaf = this.deps.getLiveLeaf(handle)
    const leaf = getLeafDisplayRecord(
      liveLeaf,
      liveLeaf.ptyId ? this.deps.getTitleDisplayClear(liveLeaf.ptyId) : null
    )
    const trackedPty = leaf.ptyId ? this.deps.getTrackedPty(leaf.ptyId) : null
    const titleProves = (
      title: string | null,
      classification: ReturnType<typeof classifyAgentTitle>
    ): boolean =>
      trackedPty
        ? ptyTitleProvesAgentPresence(trackedPty, title, classification)
        : agentTitleProvesAgentPresence(title, classification)
    const paneTitle = getLatestLeafTitle(leaf, null)
    const paneClassification = classifyAgentTitle(paneTitle)
    const tabTitle = this.deps.getTabTitle(leaf.tabId)
    const tabClassification = paneTitle === null ? classifyAgentTitle(tabTitle) : 'neutral'
    const waitText = buildTerminalWaitText(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview)
    return {
      ptyId: leaf.ptyId,
      shown:
        titleProves(paneTitle, paneClassification) ||
        titleProves(tabTitle, tabClassification) ||
        (!isOpenCodeNativeTitle(paneTitle ?? tabTitle) && isKnownReadyPromptPreview(waitText)),
      untitledStatus: leaf.lastAgentStatus !== null && paneTitle === null && tabTitle === null,
      suppressClaude: paneClassification === 'management' || tabClassification === 'management'
    }
  }

  private async waitForWrappedAgent(ptyId: string, suppressClaude: boolean): Promise<boolean> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < WRAPPER_RETRY_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, WRAPPER_RETRY_INTERVAL_MS))
      const refreshed = await this.deps.getForegroundProcess(ptyId)
      const recognized = recognizeAgentProcess(refreshed)
      if (recognized) {
        return !(suppressClaude && isExpectedAgentProcess(recognized.processName, 'claude'))
      }
      if (!refreshed || !isAgentForegroundWrapperProcess(refreshed)) {
        return false
      }
    }
    return false
  }
}

function readPtyEvidence(
  pty: RuntimePtyWorktreeRecord,
  leaf: RuntimeLeafRecord | null
): PaneAgentEvidence {
  const leafTitle = leaf
    ? getLatestAgentCandidateTitle(
        { title: leaf.paneTitle, updatedAt: leaf.paneTitleUpdatedAt },
        { title: leaf.lastOscTitle, updatedAt: leaf.lastOscTitleAt }
      )
    : null
  const leafClassification = classifyAgentTitle(leafTitle)
  const ptyTitle = getLatestAgentCandidateTitle(
    { title: pty.title, updatedAt: pty.titleUpdatedAt },
    { title: pty.lastOscTitle, updatedAt: pty.lastOscTitleAt }
  )
  const markerTitle = leafTitle ?? ptyTitle
  const waitText = buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
  const management =
    classifyLatestAgentTitle({ title: pty.managementTitle, updatedAt: pty.managementTitleAt }) ===
    'management'
  return {
    ptyId: pty.ptyId,
    shown:
      ptyTitleProvesAgentPresence(pty, leafTitle, leafClassification) ||
      (leafTitle === null &&
        ptyTitleProvesAgentPresence(pty, ptyTitle, classifyAgentTitle(ptyTitle))) ||
      (isOpenCodeNativeTitle(markerTitle) && pty.launchAgent === 'opencode') ||
      (!isOpenCodeNativeTitle(markerTitle) && isKnownReadyPromptPreview(waitText)),
    untitledStatus:
      pty.lastAgentStatus !== null && leafTitle === null && ptyTitle === null && !management,
    suppressClaude: leafTitle !== null ? leafClassification === 'management' : management
  }
}
