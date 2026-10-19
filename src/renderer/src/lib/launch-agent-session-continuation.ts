import { toast } from 'sonner'
import { getAgentLabel } from '@/lib/agent-catalog'
import { ensureDetectedAgentsForWorktree } from '@/lib/agent-detection-target-inventory'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { useAppStore } from '@/store'
import {
  acquireAgentLaunchChoices,
  AgentLaunchChoiceCancelled
} from './host-chat-program-acquisition'
import { agentChoicePending } from './host-chat-program'
import { worktreeLaunchWorkspace } from './agent-launch-route-input'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import type { LaunchSource } from '../../../shared/telemetry-events'
import type { TuiAgent } from '../../../shared/tui-agent'
import { translate } from '@/i18n/i18n'

type LaunchAgentSessionContinuationArgs = {
  agent: TuiAgent
  prompt: string
  worktreeId: string
  groupId?: string | null
  initialCwd?: string | null
  launchSource: LaunchSource
  signal?: AbortSignal
}

/** The agents a continuation can start here: detected ones, then those that open as a chat on
 *  the workspace's host without their CLI. */
export async function detectAgentSessionContinuationAgents(
  worktreeId: string,
  signal?: AbortSignal
) {
  return acquireAgentLaunchChoices(
    worktreeLaunchWorkspace(worktreeId),
    () => ensureDetectedAgentsForWorktree(useAppStore.getState(), worktreeId),
    signal
  )
}

async function ensureAgentAvailable(
  agent: TuiAgent,
  worktreeId: string,
  signal?: AbortSignal
): Promise<boolean> {
  const state = useAppStore.getState()
  const label = getAgentLabel(agent)
  if (!isTuiAgentEnabled(agent, state.settings?.disabledTuiAgents)) {
    toast.error(
      translate(
        'components.agentSessionContinuation.agentDisabled',
        '{{agent}} is disabled in Agent settings.',
        { agent: label }
      )
    )
    return false
  }

  let detectedAgents: TuiAgent[]
  try {
    detectedAgents = (await detectAgentSessionContinuationAgents(worktreeId, signal)).offered
  } catch (error) {
    if (error instanceof AgentLaunchChoiceCancelled) {
      return false
    }
    console.error('Agent detection failed for session continuation', error)
    detectedAgents = []
  }
  if (
    detectedAgents.includes(agent) ||
    agentChoicePending(useAppStore.getState(), agent, worktreeLaunchWorkspace(worktreeId), null)
  ) {
    return true
  }

  toast.error(
    translate(
      'components.agentSessionContinuation.agentUnavailable',
      '{{agent}} was not detected on this workspace host.',
      { agent: label }
    )
  )
  return false
}

export async function launchAgentSessionContinuation({
  agent,
  prompt,
  worktreeId,
  groupId,
  initialCwd,
  launchSource,
  signal
}: LaunchAgentSessionContinuationArgs): Promise<boolean> {
  if (!(await ensureAgentAvailable(agent, worktreeId, signal))) {
    return false
  }

  const label = getAgentLabel(agent)
  // Why: the paste helper writes blind when the agent's composer was never observed, so a
  // written prompt is not a delivered one. Claiming success there is how the whole handoff
  // could vanish silently (#22479).
  let deliveryUnconfirmed = false
  const result = launchAgentInNewTab({
    requestId: newAgentLaunchRequestId(),
    agent,
    worktreeId,
    ...(groupId ? { groupId } : {}),
    prompt,
    promptDelivery: agent === 'claude' ? 'draft' : 'submit-after-ready',
    launchSource,
    ...(initialCwd ? { initialCwd } : {}),
    onPromptDeliveryUnconfirmed: () => {
      deliveryUnconfirmed = true
    },
    onPromptDelivered: () => {
      if (deliveryUnconfirmed) {
        notifyDeliveryUnconfirmed(label, prompt)
        return
      }
      toast.success(
        translate(
          'components.agentSessionContinuation.sent',
          'Session context sent to {{agent}} in a new session.',
          { agent: label }
        )
      )
    }
  })
  if (!result) {
    notifyLaunchFailed(label)
    return false
  }

  if (result.promptDeliveryResult) {
    void result.promptDeliveryResult
      .then((delivery) => {
        if (!delivery.delivered && !delivery.failureNotified) {
          notifyDeliveryFailed(label, prompt)
        }
      })
      .catch((error) => {
        console.error('Agent session continuation prompt delivery failed', error)
        notifyDeliveryFailed(label, prompt)
      })
  }
  return true
}

function notifyLaunchFailed(agentLabel: string): void {
  toast.error(
    translate(
      'components.agentSessionContinuation.launchFailed',
      'Could not start a new {{agent}} session.',
      { agent: agentLabel }
    )
  )
}

function notifyDeliveryFailed(agentLabel: string, prompt: string): void {
  toast.error(
    translate(
      'components.agentSessionContinuation.deliveryFailed',
      'The new {{agent}} session started, but its context could not be sent.',
      { agent: agentLabel }
    ),
    copyPromptToastAction(prompt)
  )
}

/** The prompt was written to the PTY but the agent never showed an input-ready composer. */
function notifyDeliveryUnconfirmed(agentLabel: string, prompt: string): void {
  toast.warning(
    translate(
      'components.agentSessionContinuation.deliveryUnconfirmed',
      'Orca could not confirm {{agent}} received the session context. Check the new session, and paste it yourself if its input is empty.',
      { agent: agentLabel }
    ),
    copyPromptToastAction(prompt)
  )
}

function copyPromptToastAction(prompt: string): {
  action: { label: string; onClick: () => void }
} {
  return {
    action: {
      label: translate('components.agentSessionContinuation.copyPrompt', 'Copy prompt'),
      onClick: () => {
        void window.api.ui.writeClipboardText(prompt)
      }
    }
  }
}
