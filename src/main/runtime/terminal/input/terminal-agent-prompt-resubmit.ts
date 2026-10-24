import { OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission } from '../wait/terminal-wait-permission'
import type { RuntimeAgentPromptWriteOptions } from '../../runtime-terminal-contracts'
import { AGENT_PROMPT_SUBMIT } from '../../../../shared/agent-prompt-injection'
import type { AgentPromptActivity } from '../../agent-prompt-submission-verification'
import {
  isAgentPromptStalledError,
  verifyAgentPromptSubmission
} from '../../agent-prompt-submission-verification'
import { TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'

export abstract class OrcaRuntimeWithResubmitHeldAgentPrompt extends OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission {
  /**
   * Presses Enter again while the composer still holds the prompt, for agents that can drop the
   * first one (`submitRetryDelayMs`): a launch composer drawn before Enter is live, or a Windows
   * paste burst still being read, which takes an early Enter as a newline. Best effort: it never
   * fails a prompt the first Enter submitted.
   */
  protected async resubmitHeldAgentPrompt(
    ptyId: string,
    generation: number,
    options: RuntimeAgentPromptWriteOptions,
    held: {
      baseline: AgentPromptActivity
      readActivity: () => AgentPromptActivity
      heldBudgetMs: number
    }
  ): Promise<number> {
    const agent = this.getPtyAgent(ptyId)
    const retryDelayMs = agent ? TUI_AGENT_CONFIG[agent]?.submitRetryDelayMs : undefined
    if (retryDelayMs === undefined) {
      return 0
    }
    const deadline = Date.now() + held.heldBudgetMs
    // Why blind once: a launch composer the caller saw ready may not be one the draft reader knows.
    let blind = options.composerReady === true
    let resubmits = 0
    try {
      do {
        try {
          await verifyAgentPromptSubmission({
            baseline: held.baseline,
            readActivity: held.readActivity,
            allowOutputEvidence: false,
            timeoutMs: retryDelayMs,
            signal: options.signal
          })
          return resubmits
        } catch (error) {
          if (!isAgentPromptStalledError(error)) {
            return resubmits
          }
        }
        this.assertAgentPromptGeneration(ptyId, generation)
        // Why the draft: a second Enter into whatever the agent opened after taking the prompt
        // could answer it; a composer still holding text is the only safe target.
        const holdsDraft =
          blind || Boolean((await this.readCurrentTerminalWaitScreen(ptyId))?.draft)
        if (!holdsDraft) {
          // No draft before any retry may be a burst still being read; after one, it was taken.
          if (resubmits > 0) {
            return resubmits
          }
          continue
        }
        blind = false
        await options.beforeWrite?.(ptyId)
        if (!this.ptyController?.write(ptyId, AGENT_PROMPT_SUBMIT, options.inputKind)) {
          return resubmits
        }
        resubmits += 1
      } while (Date.now() < deadline)
    } catch {
      // Why: a refused retry leaves the first Enter's verdict to the verification that follows.
    }
    return resubmits
  }
}
