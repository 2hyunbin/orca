import type { Tab } from '../../../shared/tab-types'
import type {
  AgentSessionLaunchPlan,
  AgentSessionLaunchTarget
} from '@/lib/agent-session-launch-plan'
import type {
  StructuredAgentLaunchHandle,
  StructuredAgentLaunchHooks,
  StructuredAgentLaunchSettlement
} from '@/lib/structured-agent-launch-settlement'
import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  notifyHostDeclined,
  openDeclinedStructuredLaunchTerminal,
  type DeclinedStructuredLaunchTerminalOptions,
  type StructuredLaunchTerminal
} from '@/lib/structured-agent-session-launch-admission'
import { structuredAgentSessionFocusOwner } from '@/runtime/structured-agent-session-owner'
import { clearWebSessionFocusIntentIfMatches } from '@/runtime/web-session-focus-intent'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { NativeChatComposerFocusIntent } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
import { nativeChatComposerHasUserContent } from '@/components/native-chat/native-chat-pending-attachment-cache'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/structured-agent-session-launch-errors'

export type LocalProvisionalLaunch = StructuredAgentLaunchHandle & { tab: Tab }

export type ProvisionalLaunchArgs = {
  plan: AgentSessionLaunchPlan
  hooks: StructuredAgentLaunchHooks
  focusIntent?: NativeChatComposerFocusIntent
  target?: AgentSessionLaunchTarget
  targetGroupId?: string
  /** The tab the chat opens right after, in that tab's group. */
  afterTabId?: string
  activate?: boolean
  /** Identity-only resumes publish on commit; unknown outcomes keep their recovery tab. */
  deferPublication?: true
  /** Lets workspace flows reveal before the chat's tab is owned: before its host is asked, when no
   *  session id exists yet. */
  beforeOpen?: (sessionId?: string) => boolean | void
  /** The terminal the host's "no" opens; a caller without one gets a new agent tab's. `false`
   *  opens it behind a chat the user already typed in. */
  onHostDeclined?: (
    target: RuntimeClientTarget,
    activate?: false
  ) => Promise<StructuredLaunchTerminal> | StructuredLaunchTerminal
  /** What that default terminal carries from the caller, e.g. a recipe's saved CLI arguments. */
  declinedTerminal?: DeclinedStructuredLaunchTerminalOptions
}

export type LaunchOwner = { executionHostId: ExecutionHostId; target: RuntimeClientTarget }

export function openDeclinedTerminal(
  args: ProvisionalLaunchArgs,
  worktreeId: string,
  target: RuntimeClientTarget,
  activate?: false
): Promise<StructuredLaunchTerminal> | StructuredLaunchTerminal {
  if (args.onHostDeclined) {
    return activate === false ? args.onHostDeclined(target, false) : args.onHostDeclined(target)
  }
  const terminal = { ...args.declinedTerminal, ...(activate === false ? { activate } : {}) }
  return openDeclinedStructuredLaunchTerminal({
    plan: args.plan,
    worktreeId,
    ...(args.targetGroupId ? { targetGroupId: args.targetGroupId } : {}),
    terminal
  })
}

/** A New Chat the user just asked for opens its chat now, so the next key has a composer; its own
 *  launch asks the host. A prompt to deliver keeps asking first: a "no" hands it to a terminal. */
export function opensAtAction(args: ProvisionalLaunchArgs): boolean {
  const { plan } = args
  return (
    args.focusIntent !== undefined &&
    args.activate !== false &&
    !plan.resumeFrom &&
    (!plan.prompt?.trim() || plan.promptDelivery === 'draft')
  )
}

/** A definite "no" opens the agent's terminal: in place of a chat nobody typed in yet, where
 *  asking first used to land, or behind one with typing, which keeps it. A chat the user picked
 *  by name never becomes a terminal; its own notice says why. */
async function openTerminalForDeclinedChat(
  args: ProvisionalLaunchArgs,
  worktreeId: string,
  owner: LaunchOwner,
  tab: Tab,
  settlement: StructuredAgentLaunchSettlement
): Promise<StructuredAgentLaunchSettlement> {
  if (
    args.plan.requestedSurface === 'chat' ||
    settlement.kind !== 'failed' ||
    !(settlement.error instanceof StructuredAgentSessionCreateRefusalError) ||
    settlement.error.code !== 'structured_agent_session_unsupported'
  ) {
    return settlement
  }
  const scopeKey = structuredAgentSessionDraftScopeKey(tab.entityId)
  const typed = nativeChatComposerHasUserContent(scopeKey)
  const terminal = await openDeclinedTerminal(
    args,
    worktreeId,
    owner.target,
    typed ? false : undefined
  )
  if (!terminal.opened) {
    return settlement
  }
  if (owner.target.kind === 'environment') {
    notifyHostDeclined(args.plan.agent)
  }
  if (typed || nativeChatComposerHasUserContent(scopeKey)) {
    return settlement
  }
  useAppStore.getState().closeUnifiedTab(tab.id)
  return { kind: 'terminal' }
}

/** Takes a New Chat opened at once: its chat is the visible tab, and a host's "no" may open the
 *  agent's terminal. */
export function adoptActionLaunch(
  args: ProvisionalLaunchArgs,
  worktreeId: string,
  owner: LaunchOwner,
  launch: LocalProvisionalLaunch
): LocalProvisionalLaunch {
  // The chat is already the visible tab; its host's copy arriving later must not pull focus back.
  clearWebSessionFocusIntentIfMatches(
    structuredAgentSessionFocusOwner(owner.target),
    worktreeId,
    `agent-session:${launch.sessionId}`
  )
  return {
    ...launch,
    settlement: launch.settlement.then((settlement) =>
      openTerminalForDeclinedChat(args, worktreeId, owner, launch.tab, settlement)
    )
  }
}
