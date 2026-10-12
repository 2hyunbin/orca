import type { RuntimeAgentPromptWriteOptions } from '../../runtime-terminal-contracts'
import type {
  RuntimeTerminalPromptDelivery,
  RuntimeTerminalSend
} from '../../../../shared/runtime-types'
import {
  assertAgentPromptRequestActive,
  waitForAgentPromptDelay,
  waitForAgentPromptPromise
} from '../../orca-runtime-core'
import {
  AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS,
  AGENT_PROMPT_SUBMIT,
  agentPromptSubmitJoinsPasteFrame,
  getAgentPromptSubmitDelayMs,
  getTerminalPasteIngestMs,
  resolveAgentPromptSubmitDelayForAgent
} from '../../../../shared/agent-prompt-injection'
import {
  type AgentPromptWaitTextCache,
  isTerminalSendSettlementAgent,
  resolveAgentPromptEffectTimeoutMs,
  verifyAgentPromptSubmission,
  type AgentPromptActivity,
  type AgentPromptTurnStartEvidence
} from '../../agent-prompt-submission-verification'

import { TUI_AGENT_CONFIG, type TuiAgentConfig } from '../../../../shared/tui-agent-config'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import type { RuntimePtyController } from '../../runtime-pty-controller-contract'

import type { TerminalAgent } from '../../../../shared/terminal-agent'

import type { TerminalAgentPromptRender } from './terminal-agent-prompt-render'
const retryConfigs: Readonly<Partial<Record<TerminalAgent, TuiAgentConfig>>> = TUI_AGENT_CONFIG
type TerminalAgentPromptHost = {
  getPty(id: string): Pick<RuntimePtyWorktreeRecord, 'launchAgent' | 'foregroundAgent'> | undefined
  getController(): Pick<RuntimePtyController, 'write'> | null
  assertAgentPromptGeneration(): (id: string, generation: number) => void
  getAgentPromptActivity(): (
    handle: string,
    id: string,
    cache?: AgentPromptWaitTextCache
  ) => AgentPromptActivity
  assertAgentPromptPermissionSafe(): (
    baseline: AgentPromptActivity,
    current: AgentPromptActivity
  ) => void
  getPtyWriteHostPlatform(): (id: string) => NodeJS.Platform
  createAgentPromptRenderGate(): TerminalAgentPromptRender['createAgentPromptRenderGate']
  getPtyAgent(): (id: string) => TerminalAgent | null
  getTerminalPromptRequestBinding(): (handle: string) => {
    processIncarnation: string
  }
  registerAgentPromptRequest(): (
    id: string,
    generation: number,
    requestId: string,
    sequence: number,
    at: number | null
  ) => void
  acceptAgentPromptTurnStart(): (
    id: string,
    generation: number,
    requestId: string,
    sequence: number,
    at: number | null,
    evidence: AgentPromptTurnStartEvidence
  ) => boolean
  forgetAgentPromptRequest(): (id: string, generation: number, requestId: string) => void
}
export class TerminalAgentPrompt {
  constructor(private readonly host: TerminalAgentPromptHost) {}
  async writeTerminalAgentPrompt(
    handle: string,
    ptyId: string,
    generation: number,
    pastePayload: string,
    options: RuntimeAgentPromptWriteOptions
  ): Promise<{ submits: number; prompt?: RuntimeTerminalPromptDelivery }> {
    assertAgentPromptRequestActive(options.signal)
    this.host.assertAgentPromptGeneration()(ptyId, generation)
    const permissionBaseline = this.host.getAgentPromptActivity()(handle, ptyId)
    this.host.assertAgentPromptPermissionSafe()(permissionBaseline, permissionBaseline)
    const writeHostPlatform = this.host.getPtyWriteHostPlatform()(ptyId)
    const pty = this.host.getPty(ptyId)
    // OMP treats a large bracketed paste as a menu unless submit arrives in the same PTY write.
    // Once a foreground agent is known, it is the process that will consume the bytes;
    // launchAgent is only the fallback during startup before process detection settles.
    const submitWithPaste = agentPromptSubmitJoinsPasteFrame(
      pty?.foregroundAgent ?? pty?.launchAgent
    )
    const pasteByteLength = Buffer.byteLength(pastePayload, 'utf8')
    const pasteIngestMs = getTerminalPasteIngestMs(writeHostPlatform, pasteByteLength)
    // Why no gate for a ready composer: a live Claude never settles it, so Enter always waited out
    // its 8 s cap, where the desktop's own paste submitted in about 2 s.
    const renderGate = options.composerReady
      ? null
      : this.host.createAgentPromptRenderGate()(ptyId, pasteIngestMs)
    const waitTextCache: AgentPromptWaitTextCache = {}
    const preSubmitBaseline = submitWithPaste
      ? this.host.getAgentPromptActivity()(handle, ptyId, waitTextCache)
      : undefined
    try {
      assertAgentPromptRequestActive(options.signal)
      this.host.assertAgentPromptGeneration()(ptyId, generation)
      await options.beforeWrite?.(ptyId)
      assertAgentPromptRequestActive(options.signal)
      this.host.assertAgentPromptGeneration()(ptyId, generation)
      this.host.assertAgentPromptPermissionSafe()(
        permissionBaseline,
        this.host.getAgentPromptActivity()(handle, ptyId)
      )
      // Keep the bracketed paste frame in one PTY write; Claude's composer can drop the
      // beginning when a large frame is split into independently processed chunks.
      renderGate?.arm()
      const initialWrite = submitWithPaste ? pastePayload + AGENT_PROMPT_SUBMIT : pastePayload
      if (!this.host.getController()?.write(ptyId, initialWrite, options.inputKind)) {
        throw new Error('terminal_not_writable')
      }
    } catch (error) {
      renderGate?.dispose()
      throw error
    }

    if (submitWithPaste) {
      // The Enter was part of the paste frame; waiting here would only delay receipt settlement.
      renderGate?.dispose()
    } else if (renderGate) {
      try {
        await waitForAgentPromptPromise(renderGate.wait(), options.signal)
      } finally {
        renderGate.dispose()
      }
    } else if (options.composerReady) {
      await waitForAgentPromptDelay(
        AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS + pasteIngestMs,
        options.signal
      )
    } else {
      const agent = this.host.getPtyAgent()(ptyId)
      const submitDelayMs = options.promptForSchedule
        ? resolveAgentPromptSubmitDelayForAgent(writeHostPlatform, options.promptForSchedule, agent)
        : getAgentPromptSubmitDelayMs(writeHostPlatform, pasteByteLength)
      await waitForAgentPromptDelay(submitDelayMs, options.signal)
    }
    assertAgentPromptRequestActive(options.signal)
    this.host.assertAgentPromptGeneration()(ptyId, generation)
    if (!submitWithPaste) {
      try {
        await options.beforeWrite?.(ptyId)
      } catch (error) {
        if (options.suffixFailureError) {
          throw new Error(options.suffixFailureError)
        }
        throw error
      }
      assertAgentPromptRequestActive(options.signal)
      this.host.assertAgentPromptGeneration()(ptyId, generation)
    }
    const baseline =
      preSubmitBaseline ?? this.host.getAgentPromptActivity()(handle, ptyId, waitTextCache)
    this.host.assertAgentPromptPermissionSafe()(permissionBaseline, baseline)
    if (!submitWithPaste) {
      if (!this.host.getController()?.write(ptyId, AGENT_PROMPT_SUBMIT, options.inputKind)) {
        throw new Error(options.suffixFailureError ?? 'terminal_not_writable')
      }
    }
    const submits =
      options.composerReady && !submitWithPaste
        ? 1 + (await this.resubmitAgentPromptAfterRetryDelay(ptyId, generation, options))
        : 1
    const effectTimeoutMs = resolveAgentPromptEffectTimeoutMs(this.host.getPtyAgent()(ptyId))
    if (!options.acceptQueued || !options.requestId) {
      await verifyAgentPromptSubmission({
        baseline,
        readActivity: () => this.host.getAgentPromptActivity()(handle, ptyId, waitTextCache),
        timeoutMs: effectTimeoutMs,
        signal: options.signal
      })
      return { submits }
    }
    const binding = this.host.getTerminalPromptRequestBinding()(handle)
    const foregroundAgent = this.host.getPty(ptyId)?.foregroundAgent
    const launchAgent = this.host.getPty(ptyId)?.launchAgent
    const settlementAgent = isTerminalSendSettlementAgent(foregroundAgent)
      ? foregroundAgent
      : isTerminalSendSettlementAgent(launchAgent)
        ? launchAgent
        : null
    const inputAccepted: RuntimeTerminalPromptDelivery = {
      requestId: options.requestId,
      stages: ['input_accepted'],
      provider: settlementAgent ?? 'unsupported',
      observation: settlementAgent ? 'supported' : 'unsupported',
      processIncarnation: binding.processIncarnation,
      generation,
      baselineWorkingSequence: baseline.workingSequence,
      baselineExplicitWorkingStartedAt: baseline.explicitWorkingStartedAt,
      baselinePermissionSequence: baseline.permissionSequence
    }
    const checkpoint: RuntimeTerminalSend = {
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(pastePayload, 'utf8') + 1,
      prompt: inputAccepted
    }
    options.onInputAccepted?.(checkpoint)
    // Providers without a lifecycle verifier still get an honest accepted
    // receipt; they must not fail a Dispatch merely because Orca cannot prove
    // submission through hooks.
    if (!settlementAgent) {
      return { submits, prompt: inputAccepted }
    }
    this.host.registerAgentPromptRequest()(
      ptyId,
      generation,
      options.requestId,
      baseline.workingSequence,
      baseline.explicitWorkingStartedAt
    )
    try {
      await verifyAgentPromptSubmission({
        baseline,
        readActivity: () => this.host.getAgentPromptActivity()(handle, ptyId, waitTextCache),
        acceptTurnStart: (evidence) =>
          this.host.acceptAgentPromptTurnStart()(
            ptyId,
            generation,
            options.requestId!,
            baseline.workingSequence,
            baseline.explicitWorkingStartedAt,
            evidence
          ),
        allowOutputEvidence: false,
        signal: options.signal,
        timeoutMs: options.observationTimeoutMs ?? effectTimeoutMs
      })
      this.host.forgetAgentPromptRequest()(ptyId, generation, options.requestId)
      return {
        submits,
        prompt: {
          ...inputAccepted,
          stages: ['input_accepted', 'turn_started']
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'agent_prompt_stalled') {
        return { submits, prompt: inputAccepted }
      }
      if (error instanceof Error && error.message === 'agent_prompt_blocked') {
        this.host.forgetAgentPromptRequest()(ptyId, generation, options.requestId)
        return {
          submits,
          prompt: { ...inputAccepted, observation: 'permission' }
        }
      }
      throw error
    }
  }
  private async resubmitAgentPromptAfterRetryDelay(
    ptyId: string,
    generation: number,
    options: RuntimeAgentPromptWriteOptions
  ): Promise<number> {
    const agent = this.host.getPtyAgent()(ptyId)
    const retryDelayMs = agent ? retryConfigs[agent]?.submitRetryDelayMs : undefined
    if (retryDelayMs === undefined) {
      return 0
    }
    try {
      await waitForAgentPromptDelay(retryDelayMs, options.signal)
      this.host.assertAgentPromptGeneration()(ptyId, generation)
      await options.beforeWrite?.(ptyId)
      return this.host.getController()?.write(ptyId, AGENT_PROMPT_SUBMIT, options.inputKind) ? 1 : 0
    } catch {
      return 0
    }
  }
}
