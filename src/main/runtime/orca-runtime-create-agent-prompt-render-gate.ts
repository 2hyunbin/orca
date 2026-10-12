import { TerminalAgentPromptRender } from './terminal/input/terminal-agent-prompt-render'
import { OrcaRuntimeWithWriteTerminalAgentPrompt } from './orca-runtime-write-terminal-agent-prompt'

import type { RuntimeTerminalWait, RuntimeTerminalWaitCondition } from '../../shared/runtime-types'

export abstract class OrcaRuntimeWithCreateAgentPromptRenderGate extends OrcaRuntimeWithWriteTerminalAgentPrompt {
  private readonly promptRender = new TerminalAgentPromptRender({
    getPty: (ptyId) => this.ptysById.get(ptyId),
    subscribeToTerminalData: () => this.subscribeToTerminalData.bind(this)
  })

  protected createAgentPromptRenderGate(
    ...args: Parameters<TerminalAgentPromptRender['createAgentPromptRenderGate']>
  ) {
    return this.promptRender.createAgentPromptRenderGate(...args)
  }

  waitForTerminal(
    handle: string,
    options?: {
      condition?: RuntimeTerminalWaitCondition
      timeoutMs?: number
      signal?: AbortSignal
      launchReadiness?: boolean
    }
  ): Promise<RuntimeTerminalWait> {
    return this.terminalWait.wait(handle, options)
  }
}
