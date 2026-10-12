import type { TerminalAgentPromptRender } from './terminal/input/terminal-agent-prompt-render'
import { TerminalAgentPrompt } from './terminal/input/terminal-agent-prompt'
import { OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission } from './orca-runtime-resolve-authoritative-terminal-wait-permission'

export abstract class OrcaRuntimeWithWriteTerminalAgentPrompt extends OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission {
  protected abstract createAgentPromptRenderGate(
    ...args: Parameters<TerminalAgentPromptRender['createAgentPromptRenderGate']>
  ): ReturnType<TerminalAgentPromptRender['createAgentPromptRenderGate']>

  private readonly promptWriter = new TerminalAgentPrompt({
    getPty: (ptyId) => this.ptysById.get(ptyId),
    getController: () => this.ptyController,
    assertAgentPromptGeneration: () => this.assertAgentPromptGeneration.bind(this),
    getAgentPromptActivity: () => this.getAgentPromptActivity.bind(this),
    assertAgentPromptPermissionSafe: () => this.assertAgentPromptPermissionSafe.bind(this),
    getPtyWriteHostPlatform: () => this.getPtyWriteHostPlatform.bind(this),
    createAgentPromptRenderGate: () => this.createAgentPromptRenderGate.bind(this),
    getPtyAgent: () => this.getPtyAgent.bind(this),
    getTerminalPromptRequestBinding: () => this.getTerminalPromptRequestBinding.bind(this),
    registerAgentPromptRequest: () => this.registerAgentPromptRequest.bind(this),
    acceptAgentPromptTurnStart: () => this.acceptAgentPromptTurnStart.bind(this),
    forgetAgentPromptRequest: () => this.forgetAgentPromptRequest.bind(this)
  })

  protected writeTerminalAgentPrompt(
    ...args: Parameters<TerminalAgentPrompt['writeTerminalAgentPrompt']>
  ) {
    return this.promptWriter.writeTerminalAgentPrompt(...args)
  }
}
