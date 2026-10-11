import { MOBILE_SUBSCRIBE_SCROLLBACK_ROWS } from '../../scrollback-limits'
import {
  detectAgentStatusFromTitle,
  normalizeTerminalTitle
} from '../../../../shared/agent-detection'
import { shouldModelAnswerHiddenPtyQueries } from '../../terminal-model-query-authority'
import type { RuntimeTerminalOutputOwner } from './terminal-output-owner'

export function maybeHydrateHeadlessFromRenderer(
  output: RuntimeTerminalOutputOwner,
  ptyId: string
): Promise<boolean> | null {
  if (output.headlessHydrationState.has(ptyId)) {
    return null
  }
  const providerSnapshotPreferred = output.providerSnapshotPreferredPtys.has(ptyId)
  if (output.headlessTerminals.has(ptyId) && !providerSnapshotPreferred) {
    // Daemon-snapshot seed already populated the emulator — skip hydration.
    output.headlessHydrationState.set(ptyId, 'done')
    return null
  }
  const controller = output.host.ptyController
  if (!controller?.serializeBuffer || !controller.hasRendererSerializer) {
    return null
  }
  if (!controller.hasRendererSerializer(ptyId)) {
    // Renderer hasn't registered yet (or never will). Live writes lazy-
    // create the state via trackHeadlessTerminalData on this same tick.
    return null
  }

  if (providerSnapshotPreferred) {
    // Why: a stream byte can create a partial model before restored history
    // arrives. A mounted renderer snapshot can safely replace that model.
    output.host.disposeHeadlessTerminal(ptyId)
  }

  output.headlessHydrationState.set(ptyId, 'pending')
  const dims = output.host.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
  // Why: hydration writes below never set forwardQueryReplies (main-side
  // replay guard) — renderer-buffer snapshots can embed stale queries.
  const state = output.host.createPtyHeadlessTerminalState(ptyId, dims)
  state.outputSequence = output.host.getPtyOutputSequence(ptyId)
  output.headlessTerminals.set(ptyId, state)

  // Why: append the seed work to writeChain so live writes queued by
  // trackHeadlessTerminalData (after this method returns synchronously)
  // execute AFTER the seed-write resolves. If we awaited inline before
  // setting headlessTerminals, the live byte would lazy-create a separate
  // state and the seed-resolve would overwrite it, dropping live bytes.
  let seeded = false
  state.writeChain = state.writeChain.then(async () => {
    if (output.headlessTerminals.get(ptyId) !== state) {
      return
    }
    try {
      // Why the scrollback is not suppressed mid-TUI: the seed IS the model's
      // normal buffer, so zeroing it while an alt-screen agent was up left the
      // model with no pre-TUI history to restore from (#6106).
      const rendered = await controller.serializeBuffer!(ptyId, {
        scrollbackRows: MOBILE_SUBSCRIBE_SCROLLBACK_ROWS
      })
      if (
        output.headlessTerminals.get(ptyId) !== state ||
        !rendered ||
        rendered.data.length === 0
      ) {
        return
      }
      output.host.recordOsc7MetadataForPty(ptyId, rendered.data)
      output.host.recordRecentPtyOutputForPathProvenance(ptyId, rendered.data)
      // Resize to renderer's dims so the seed reflows correctly into the
      // emulator's grid, then resize back to PTY dims (if known) so live
      // writes use the correct cell layout.
      if (rendered.cols !== dims.cols || rendered.rows !== dims.rows) {
        state.emulator.resize(rendered.cols, rendered.rows)
      }
      await state.emulator.write(rendered.data)
      if (output.headlessTerminals.get(ptyId) !== state) {
        return
      }
      const ptyDims = output.host.getTerminalSize(ptyId)
      if (ptyDims && (ptyDims.cols !== rendered.cols || ptyDims.rows !== rendered.rows)) {
        state.emulator.resize(ptyDims.cols, ptyDims.rows)
      }
      // Why: the renderer xterm no longer sees synthetic hook title frames
      // (they feed main's tracker only), so its serializer lastTitle can be
      // stale here. Prefer main's tracked title; the renderer's is only the
      // seed when main has observed none (fresh relaunch, cold tracker).
      state.ownership.seedOwner(undefined, {
        alternateScreen: state.emulator.isAlternateScreen
      })
      const seedTitle = output.host.getTrackedRawTitleForPty(ptyId) ?? rendered.lastTitle
      if (seedTitle) {
        state.emulator.setLastTitle(seedTitle)
        output.host.applySeededAgentStatus(ptyId, seedTitle)
      }
      output.providerSnapshotPreferredPtys.delete(ptyId)
      seeded = true
    } catch {
      // Hydration is best-effort. Live writes continue via the same
      // writeChain that this catch-arm leaves intact.
    } finally {
      if (output.headlessTerminals.get(ptyId) === state) {
        output.headlessHydrationState.set(ptyId, 'done')
      }
    }
  })
  return state.writeChain.then(() => seeded)
}

export function applySeededAgentStatus(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  title: string
): void {
  if (!title) {
    return
  }
  // Why: a relaunched main starts its per-PTY title tracker cold — without
  // this seed it misses the parked working→idle completion and never arms
  // the stale-title timer for a persisted 'working' title. Seeding no-ops
  // once a live title was observed, so live state always wins.
  output.host.getOrCreatePtyTitleTrackerEntry(ptyId).tracker.seedInitialTitle(title)
  const status = detectAgentStatusFromTitle(title)
  // Why evidence, not display: display readers project a stale-working clear over the record,
  // so re-seeding the native working title cannot bring a cleared spinner back.
  // Why: live observations store normalized titles, so seeds must match —
  // otherwise the first live frame after hydration compares unequal and
  // touches session tabs once for no visible change.
  const seededTitle = normalizeTerminalTitle(title)
  const pty = output.host.ptysById.get(ptyId)
  if (pty) {
    const observedAt = output.host.nextTitleObservationSequence()
    pty.lastOscTitle = seededTitle
    pty.lastOscTitleAt = observedAt
    output.host.setPtyManagementTitleFromObservedTitle(pty, seededTitle, observedAt)
  }
  for (const leaf of output.host.getLeavesForPty(ptyId)) {
    // Why: seed lastOscTitle even when the seeded title doesn't classify
    // as an agent state, so worktree.ps recomputes status from the live
    // title rather than treating the leaf as agentless.
    leaf.lastOscTitle = seededTitle
    leaf.lastOscTitleAt = output.host.nextTitleObservationSequence()
    if (status !== null) {
      leaf.lastAgentStatus = status
    }
  }
}

export function shouldAnswerQueriesForLiveChunk(
  output: RuntimeTerminalOutputOwner,
  ptyId: string
): boolean {
  return shouldModelAnswerHiddenPtyQueries({
    ptyId,
    settings: output.host.store?.getSettings(),
    hasRemoteViewSubscriber: output.host.hasRemoteTerminalViewSubscriber(ptyId)
  })
}
