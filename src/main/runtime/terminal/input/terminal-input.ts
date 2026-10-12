import { wrapTerminalBracketedPasteText } from '../../../../shared/terminal-bracketed-paste-text'

import type { RuntimeTerminalSend } from '../../../../shared/runtime-types'
import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'
import type { RuntimeAgentPromptWriteOptions } from '../../runtime-terminal-contracts'
import {
  assertTerminalInputWithinLimitWithYield,
  buildTerminalSendPayload
} from '../../terminal-send-payload'
import {
  agentPromptTakesLeadLine,
  buildAgentPromptPasteBytes
} from '../../../../shared/agent-prompt-injection'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import type { RuntimeTerminalWriter } from '../../runtime-terminal-writer'
import type { TerminalPromptSubmissions } from './terminal-prompt-submissions'
import type { TerminalAgentPrompt } from './terminal-agent-prompt'
type TerminalInputHost = {
  getPty(id: string): Pick<RuntimePtyWorktreeRecord, 'launchAgent' | 'foregroundAgent'> | undefined
  getLivePtyForHandle(): (h: string) => {
    pty: RuntimePtyWorktreeRecord
  } | null
  getLiveLeafForHandle(): (h: string) => {
    leaf: RuntimeLeafRecord
  }
  isLeafPtyProvenAbsent(): (id: string) => Promise<boolean>
  getPtyLifecycleGeneration(): (id: string) => number
  assertLiveTerminalHandleTargetsPty(): (h: string, id: string) => void
  assertAgentPromptGeneration(): (id: string, generation: number) => void
  serializeAgentPromptSubmission(): TerminalPromptSubmissions['serializeAgentPromptSubmission']
  writeTerminalAgentPrompt(): TerminalAgentPrompt['writeTerminalAgentPrompt']
  writeTerminalAction(): RuntimeTerminalWriter['writeAction']
}
export class TerminalInput {
  constructor(private readonly host: TerminalInputHost) {}
  async sendTerminal(
    handle: string,
    action: {
      text?: string
      enter?: boolean
      interrupt?: boolean
    },
    options: {
      signal?: AbortSignal
      beforeWrite?: (ptyId: string) => void | Promise<void>
      reserveWrite?: (ptyId: string) => void
      afterWrite?: (ptyId: string) => void | Promise<void>
      suffixFailureError?: string
      inputKind: TerminalInputKind
      requireWriteSettlement?: true
    }
  ): Promise<RuntimeTerminalSend> {
    const pty = this.host.getLivePtyForHandle()(handle)
    if (pty) {
      if (!pty.pty.connected) {
        throw new Error('terminal_not_writable')
      }
      const payload = buildTerminalSendPayload(action)
      if (payload === null) {
        throw new Error('invalid_terminal_send')
      }
      await assertTerminalInputWithinLimitWithYield(action.text)
      const writeSettlement = await this.host.writeTerminalAction()(
        pty.pty.ptyId,
        action,
        payload,
        options
      )
      return {
        handle,
        accepted: !writeSettlement || writeSettlement.outcome === 'accepted',
        ...(writeSettlement ? { writeSettlement } : {}),
        bytesWritten:
          !writeSettlement || writeSettlement.outcome === 'accepted'
            ? Buffer.byteLength(payload, 'utf8')
            : 0
      }
    }

    const { leaf } = this.host.getLiveLeafForHandle()(handle)
    if (!leaf.writable || !leaf.ptyId) {
      throw new Error('terminal_not_writable')
    }
    const payload = buildTerminalSendPayload(action)
    if (payload === null) {
      throw new Error('invalid_terminal_send')
    }
    await assertTerminalInputWithinLimitWithYield(action.text)
    // Why: leaf.writable mirrors the renderer graph, which can still answer for
    // a prior process's ptyId — and provider writes to unknown ids are accepted
    // no-ops. Only controller-proven absence rejects; unknown proceeds (a
    // restored daemon session takes writes before its pane remounts).
    if (await this.host.isLeafPtyProvenAbsent()(leaf.ptyId)) {
      throw new Error('terminal_not_writable')
    }

    const writeSettlement = await this.host.writeTerminalAction()(
      leaf.ptyId,
      action,
      payload,
      options
    )

    return {
      handle,
      accepted: !writeSettlement || writeSettlement.outcome === 'accepted',
      ...(writeSettlement ? { writeSettlement } : {}),
      bytesWritten:
        !writeSettlement || writeSettlement.outcome === 'accepted'
          ? Buffer.byteLength(payload, 'utf8')
          : 0
    }
  }
  async sendTerminalAgentPrompt(
    handle: string,
    prompt: string,
    options: RuntimeAgentPromptWriteOptions
  ): Promise<RuntimeTerminalSend> {
    // Why the consuming agent: the foreground process reads the bytes; launchAgent covers startup.
    const payloadFor = (ptyId: string): string => {
      // Why: a launch prompt replaced the desktop's draft paste, so it sends that paste's bytes.
      if (options.inputKind === 'launch') {
        return wrapTerminalBracketedPasteText(prompt)
      }
      const pty = this.host.getPty(ptyId)
      const agent = pty?.foregroundAgent ?? pty?.launchAgent
      return buildAgentPromptPasteBytes(
        prompt,
        agentPromptTakesLeadLine(agent) ? options.leadLine : undefined
      )
    }
    const pty = this.host.getLivePtyForHandle()(handle)
    if (pty) {
      if (!pty.pty.connected) {
        throw new Error('terminal_not_writable')
      }
      const payload = payloadFor(pty.pty.ptyId)
      await assertTerminalInputWithinLimitWithYield(payload)
      const generation = this.host.getPtyLifecycleGeneration()(pty.pty.ptyId)
      const delivery = await this.host.serializeAgentPromptSubmission()(
        pty.pty.ptyId,
        generation,
        async () => {
          this.host.assertLiveTerminalHandleTargetsPty()(handle, pty.pty.ptyId)
          this.host.assertAgentPromptGeneration()(pty.pty.ptyId, generation)
          return await this.host.writeTerminalAgentPrompt()(
            handle,
            pty.pty.ptyId,
            generation,
            payload,
            {
              ...options,
              promptForSchedule: prompt
            }
          )
        }
      )
      const bytesWritten = Buffer.byteLength(payload, 'utf8') + delivery.submits
      return {
        handle,
        accepted: true,
        bytesWritten,
        ...(delivery.prompt ? { prompt: delivery.prompt } : {})
      }
    }

    const { leaf } = this.host.getLiveLeafForHandle()(handle)
    if (!leaf.writable || !leaf.ptyId) {
      throw new Error('terminal_not_writable')
    }
    const payload = payloadFor(leaf.ptyId)
    await assertTerminalInputWithinLimitWithYield(payload)
    // Why: same absence gate as sendTerminal — a stale graph mirror must not
    // accept a prompt into a void; unknown liveness still proceeds.
    if (await this.host.isLeafPtyProvenAbsent()(leaf.ptyId)) {
      throw new Error('terminal_not_writable')
    }
    const generation = this.host.getPtyLifecycleGeneration()(leaf.ptyId)
    const delivery = await this.host.serializeAgentPromptSubmission()(
      leaf.ptyId,
      generation,
      async () => {
        this.host.assertLiveTerminalHandleTargetsPty()(handle, leaf.ptyId!)
        this.host.assertAgentPromptGeneration()(leaf.ptyId!, generation)
        return await this.host.writeTerminalAgentPrompt()(
          handle,
          leaf.ptyId!,
          generation,
          payload,
          {
            ...options,
            promptForSchedule: prompt
          }
        )
      }
    )
    const bytesWritten = Buffer.byteLength(payload, 'utf8') + delivery.submits
    return {
      handle,
      accepted: true,
      bytesWritten,
      ...(delivery.prompt ? { prompt: delivery.prompt } : {})
    }
  }
}
