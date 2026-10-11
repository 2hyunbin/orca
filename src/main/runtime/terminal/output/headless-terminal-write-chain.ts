import { splitFreebuffScreenUpdates } from '../../../../shared/freebuff-screen-status'

import { observeFreebuffTerminalStatus } from '../../freebuff-terminal-status'

import type { RuntimeTerminalOutputOwner } from './terminal-output-owner'

export function trackHeadlessTerminalData(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  data: string,
  outputSequence: number,
  forwardQueryReplies = false
): void {
  const state = output.host.getOrCreateHeadlessTerminal(ptyId)
  const completion = state.writeChain.then(async () => {
    // Why: the ingestion-time ownership decision is closed over this
    // chain link; async scheduling cannot retroactively change it.
    // Why inside the chain: the ownership mirror must observe live bytes in
    // the same total order as seeds (seedOwner also runs on this chain).
    state.ownership.scan(data)
    for (const chunk of splitFreebuffScreenUpdates(data, state.emulator.partialEscapeTailAnsi)) {
      await state.emulator.write(chunk, { forwardQueryReplies })
      const pty = output.host.ptysById.get(ptyId)
      if (pty && !pty.connectionId && output.headlessTerminals.get(ptyId) === state) {
        const payload = observeFreebuffTerminalStatus(
          state.emulator,
          chunk,
          output.terminalSpawnCommandsByPtyId.get(ptyId),
          pty.launchAgent
        )
        if (payload) {
          pty.lastExplicitAgentStatus = {
            state: payload.state,
            updatedAt: Date.now(),
            sessionBoundary: payload.sessionBoundary
          }
          output.host.emitTerminalAgentStatusEvents(ptyId, {
            cleanData: '',
            payloads: [payload],
            lastPayloadCleanOffset: null
          })
        }
      }
    }
    state.outputSequence = outputSequence
  })
  state.writeChain = completion.catch(() => {})
}
