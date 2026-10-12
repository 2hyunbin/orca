// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { TerminalInput } from './terminal/input/terminal-input'
import { OrcaRuntimeWithResolveTerminalPane } from './orca-runtime-resolve-terminal-pane'

import { PROVEN_ABSENT_LEAF_PTY_TTL_MS } from './orca-runtime-core'
import { pruneExpiredProvenAbsentLeafPtyVerdicts } from './proven-absent-leaf-pty-verdicts'

export class OrcaRuntimeWithControllerKnowsPtyIsLive extends OrcaRuntimeWithResolveTerminalPane {
  private readonly terminalInput = new TerminalInput({
    getPty: (ptyId) => this.ptysById.get(ptyId),
    getLivePtyForHandle: () => this.getLivePtyForHandle.bind(this),
    getLiveLeafForHandle: () => this.getLiveLeafForHandle.bind(this),
    isLeafPtyProvenAbsent: () => this.isLeafPtyProvenAbsent.bind(this),
    getPtyLifecycleGeneration: () => this.getPtyLifecycleGeneration.bind(this),
    assertLiveTerminalHandleTargetsPty: () => this.assertLiveTerminalHandleTargetsPty.bind(this),
    assertAgentPromptGeneration: () => this.assertAgentPromptGeneration.bind(this),
    serializeAgentPromptSubmission: () => this.serializeAgentPromptSubmission.bind(this),
    writeTerminalAgentPrompt: () => this.writeTerminalAgentPrompt.bind(this),
    writeTerminalAction: () => this.writeTerminalAction.bind(this)
  })

  private lastProvenAbsentLeafPtyVerdictPruneAt: number | undefined

  private pruneExpiredLeafPtyVerdicts(now: number): void {
    const lastPruneAt = this.lastProvenAbsentLeafPtyVerdictPruneAt
    // Per-key expiry stays exact; throttle whole-cache scans on the keystroke path.
    if (
      lastPruneAt !== undefined &&
      now >= lastPruneAt &&
      now - lastPruneAt < PROVEN_ABSENT_LEAF_PTY_TTL_MS
    ) {
      return
    }
    this.lastProvenAbsentLeafPtyVerdictPruneAt = now
    pruneExpiredProvenAbsentLeafPtyVerdicts(
      this.provenAbsentLeafPtyVerdicts,
      now,
      PROVEN_ABSENT_LEAF_PTY_TTL_MS
    )
  }

  protected controllerKnowsPtyIsLive(ptyId: string): boolean {
    try {
      return this.ptyController?.hasPty?.(ptyId) === true
    } catch {
      // Why: liveness lookup failures are doubt; doubt never gates a write.
      return false
    }
  }

  /** True only on controller-proven absence; live, unknown, and probe errors all answer false. */
  protected isLeafPtyProvenAbsent(ptyId: string): Promise<boolean> {
    this.pruneExpiredLeafPtyVerdicts(Date.now())
    // Why hasPty and not ptysById: graph sync mirrors a connected record for
    // every leaf ptyId — including a prior process's — so runtime records can't
    // distinguish live from stale. The controller's exact-id hasPty is the
    // provider's own synchronous inventory: a known id is alive, skip probing
    // and supersede any cached verdict (the id came back).
    if (this.controllerKnowsPtyIsLive(ptyId)) {
      this.provenAbsentLeafPtyVerdicts.delete(ptyId)
      return Promise.resolve(false)
    }
    const verdictAt = this.provenAbsentLeafPtyVerdicts.get(ptyId)
    if (verdictAt !== undefined) {
      if (Date.now() - verdictAt < PROVEN_ABSENT_LEAF_PTY_TTL_MS) {
        return Promise.resolve(true)
      }
      this.provenAbsentLeafPtyVerdicts.delete(ptyId)
    }
    const probeLiveness = this.ptyController?.probePtyLiveness?.bind(this.ptyController)
    if (!probeLiveness) {
      return Promise.resolve(false)
    }
    const inFlight = this.leafPtyAbsenceProbes.get(ptyId)
    if (inFlight) {
      return inFlight
    }
    const probe = (async () => {
      try {
        if ((await probeLiveness(ptyId)) !== false) {
          return false
        }
        const now = Date.now()
        this.pruneExpiredLeafPtyVerdicts(now)
        this.provenAbsentLeafPtyVerdicts.set(ptyId, now)
        return true
      } catch {
        // Why: a failed probe is unknown, and unknown never rejects a write.
        return false
      } finally {
        this.leafPtyAbsenceProbes.delete(ptyId)
      }
    })()
    this.leafPtyAbsenceProbes.set(ptyId, probe)
    return probe
  }

  sendTerminal(...args: Parameters<TerminalInput['sendTerminal']>) {
    return this.terminalInput.sendTerminal(...args)
  }

  sendTerminalAgentPrompt(...args: Parameters<TerminalInput['sendTerminalAgentPrompt']>) {
    return this.terminalInput.sendTerminalAgentPrompt(...args)
  }
}
