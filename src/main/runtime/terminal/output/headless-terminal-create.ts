import type { RuntimeHeadlessTerminal } from '../../runtime-terminal-state-records'
import { HeadlessEmulator } from '../../../daemon/headless-emulator'
import { shouldForwardHeadlessTerminalQueryReply } from '../../headless-terminal-query-reply-policy'
import { isNativeWindowsConptyPty } from '../../terminal-model-query-authority'
import { getTerminalViewAttributes } from '../../terminal-view-attribute-store'
import { PtyShellOwnershipMirror } from '../../pty-shell-ownership-mirror'

import type { RuntimeTerminalOutputOwner } from './terminal-output-owner'

export function createPtyHeadlessTerminalState(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  dims: { cols: number; rows: number }
): RuntimeHeadlessTerminal {
  let state: RuntimeHeadlessTerminal | null = null
  const pathFlavor = output.host.pathFlavorForPty(output.host.ptysById.get(ptyId))
  const emulator = new HeadlessEmulator({
    cols: dims.cols,
    rows: dims.rows,
    pathFlavor,
    remotePosixFileUriAuthority:
      !!output.host.ptysById.get(ptyId)?.connectionId && pathFlavor !== 'win32',
    wslDistro: output.host.ptysById.get(ptyId)?.connectionId
      ? undefined
      : (output.host.wslDistroByPtyId.get(ptyId) ??
        output.host.ptysById.get(ptyId)?.wslDistro ??
        undefined),
    // Why: replies take the provider input path (same entry as pty:write —
    // daemon shell-ready gating and the SSH relay write apply unchanged),
    // NOT writePtyInput, so renderer interactive-output metering never
    // counts responder traffic as user-input echo.
    onQueryReply: (reply) => {
      // Why the identity check: queued writeChain links can parse after
      // disposeHeadlessTerminal, and daemon respawns reuse session ids — a
      // stale link's reply must never reach a successor PTY under this id.
      if (state !== null && output.headlessTerminals.get(ptyId) === state) {
        if (
          !shouldForwardHeadlessTerminalQueryReply(
            output.host.ptysById.get(ptyId)?.launchAgent,
            reply
          )
        ) {
          return
        }
        // Why this write is safe pre-shell-ready: daemon Session.write
        // QUEUES (never drops) input while the POSIX shell-ready gate is
        // pending and flushes at the ready marker or the 15s
        // SHELL_READY_TIMEOUT_MS bound (session.ts) — a spawn-time query
        // reply is delayed at most that bound, not lost.
        output.host.ptyController?.write(ptyId, reply, 'query-reply')
      }
    }
  })
  if (isNativeWindowsConptyPty(ptyId)) {
    emulator.installConptyPrimaryDeviceAttributesOverride()
  }
  // Why the lazy getter: replies must use the freshest renderer push at
  // parse time, and stay silent (never default) before the first push.
  emulator.installViewAttributeResponder(() => getTerminalViewAttributes())
  const viewAttributes = getTerminalViewAttributes()
  if (viewAttributes) {
    emulator.applyPushedViewAttributes(viewAttributes)
  }
  const constructed: RuntimeHeadlessTerminal = {
    emulator,
    outputSequence: 0,
    writeChain: Promise.resolve(),
    ownership: new PtyShellOwnershipMirror(async () => {
      const controller = output.host.ptyController
      const lifecycleGeneration = output.host.getPtyLifecycleGeneration(ptyId)
      if (
        !controller?.confirmShellForeground ||
        output.headlessTerminals.get(ptyId) !== constructed
      ) {
        return false
      }
      const confirmed = await controller.confirmShellForeground(ptyId)
      return (
        confirmed &&
        output.headlessTerminals.get(ptyId) === constructed &&
        output.host.getPtyLifecycleGeneration(ptyId) === lifecycleGeneration
      )
    })
  }
  state = constructed
  return state
}

export function ensureNativeWindowsConptyDa1Override(
  output: RuntimeTerminalOutputOwner,
  ptyId: string
): void {
  if (isNativeWindowsConptyPty(ptyId)) {
    output.headlessTerminals.get(ptyId)?.emulator.installConptyPrimaryDeviceAttributesOverride()
  }
}

export function getOrCreateHeadlessTerminal(
  output: RuntimeTerminalOutputOwner,
  ptyId: string
): RuntimeHeadlessTerminal {
  const existing = output.headlessTerminals.get(ptyId)
  if (existing) {
    return existing
  }
  const size = output.host.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
  const state = output.host.createPtyHeadlessTerminalState(ptyId, size)
  output.headlessTerminals.set(ptyId, state)
  return state
}

export function replaceHeadlessTerminalAfterExecutionContextChange(
  output: RuntimeTerminalOutputOwner,
  ptyId: string
): void {
  output.host.disposeHeadlessTerminal(ptyId)
  output.providerSnapshotPreferredPtys.add(ptyId)
  const dims = output.host.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
  const state = output.host.createPtyHeadlessTerminalState(ptyId, dims)
  output.headlessTerminals.set(ptyId, state)
  state.writeChain = state.writeChain
    .then(async () => {
      if (output.headlessTerminals.get(ptyId) !== state) {
        return
      }
      const snapshot = await output.host.serializeProviderTerminalBuffer(ptyId)
      if (output.headlessTerminals.get(ptyId) !== state || !snapshot) {
        return
      }
      const data = `${snapshot.scrollbackAnsi ?? ''}${snapshot.data}`
      // Why: a newer live OSC 7 can arrive while the snapshot is in flight;
      // only seed metadata while no post-correction CWD has won the race.
      if (!output.terminalCwdByPtyId.has(ptyId)) {
        output.host.recordOsc7MetadataForPty(ptyId, data)
      }
      await state.emulator.write(data)
      if (output.headlessTerminals.get(ptyId) !== state) {
        return
      }
      if (snapshot.cwd !== undefined) {
        state.emulator.setCwd(snapshot.cwd)
        if (!output.terminalCwdByPtyId.has(ptyId) && snapshot.cwd?.trim()) {
          output.terminalCwdByPtyId.set(ptyId, snapshot.cwd)
        }
      }
      if (snapshot.oscLinks !== undefined) {
        state.emulator.setRestoredOscLinks(snapshot.oscLinks)
      }
      state.ownership.seedOwner(snapshot.terminalOwner, {
        alternateScreen: state.emulator.isAlternateScreen
      })
      state.outputSequence = snapshot.seq
    })
    .catch(() => {
      // Best-effort: live bytes already chain behind this replacement state.
    })
    .finally(() => {
      if (output.headlessTerminals.get(ptyId) === state) {
        output.providerSnapshotPreferredPtys.delete(ptyId)
      }
    })
}
