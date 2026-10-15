import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'
import type { AgentSessionLaunchPlan } from '@/lib/agent-session-launch-plan'
import type { StructuredLaunchTerminal } from '@/lib/structured-agent-session-launch-admission'
import type { AgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import type { TuiAgent } from '../../../../shared/tui-agent'

export function explicitAgentLaunchPlan(
  surface: 'chat' | 'cli',
  agent: TuiAgent,
  worktreeId: string,
  requestId: AgentLaunchRequestId
): AgentSessionLaunchPlan {
  return adoptAgentSessionLaunchVerdict({
    route: surface === 'chat' ? 'structured-native-chat' : 'terminal-tui',
    requestId,
    agent,
    worktreeId
  })
}

export function rejectExplicitChat(label: string): StructuredLaunchTerminal {
  toast.error(
    translate(
      'auto.components.tab.bar.QuickLaunchButton.chatUnavailableAfterSelection',
      "Couldn't start a {{value0}} chat.",
      { value0: label }
    )
  )
  return { opened: false }
}
