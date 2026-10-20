import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/structured-agent-session-provisional-tab'
import {
  supportsInPlaceSwitch,
  supportsStructuredAgentSessionCliSource
} from '@/runtime/structured-agent-session-client'
import { CLOSE_TERMINAL_PANE_EVENT, type CloseTerminalPaneDetail } from '@/constants/terminal'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import { CLI_CONVERSATION_ADOPTING_AGENTS } from '../../../../shared/structured-agent-cli-conversation-adoption'
import { resolveCliChatResumeSource, type CliChatResumeSource } from './cli-chat-resume-source'
import { reportCliChatResumeFailure } from './cli-chat-resume-feedback'
import { adoptingAgentOnHost } from '../right-sidebar/ai-vault-session-resume-in-chat-launch'
import { forgetSwitchedTerminalConversation } from './switched-terminal-conversation'

/** The chat took the conversation, so the terminal pane it came from closes (its tab with it). */
function retireSwitchedTerminalPane(source: CliChatResumeSource): void {
  const pane = parsePaneKey(source.paneKey)
  forgetSwitchedTerminalConversation(source.tabId)
  if (pane) {
    const detail: CloseTerminalPaneDetail = { tabId: pane.tabId, leafId: pane.leafId }
    window.dispatchEvent(new CustomEvent(CLOSE_TERMINAL_PANE_EVENT, { detail }))
  }
}

const pending = new Map<string, AbortController>()
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((listener) => listener())
const keyFor = (source: CliChatResumeSource) =>
  [
    source.executionHostId,
    CLI_CONVERSATION_ADOPTING_AGENTS[source.agent],
    source.providerSessionId
  ].join('\0')
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useCliChatResumePending(source: CliChatResumeSource | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !!source && pending.has(keyFor(source)),
    () => false
  )
}

/** Switches a terminal's conversation into a chat in the terminal's slot: a new chat, or the chat
 *  that already holds it, revealed. The terminal pane closes once the chat has it. */
export async function runCliChatResume(source: CliChatResumeSource): Promise<void> {
  const key = keyFor(source)
  if (pending.has(key)) {
    return
  }
  const target = structuredAgentSessionTargetForHost(source.executionHostId)
  if (!target) {
    return
  }
  const controller = new AbortController()
  const isCurrent = () => {
    if (controller.signal.aborted) {
      return false
    }
    const current = resolveCliChatResumeSource(useAppStore.getState(), {
      tab: { id: source.tabId, worktreeId: source.workspaceId },
      paneKey: source.paneKey
    })
    return (
      !!current &&
      current.executionHostId === source.executionHostId &&
      current.providerSessionId === source.providerSessionId &&
      CLI_CONVERSATION_ADOPTING_AGENTS[current.agent] ===
        CLI_CONVERSATION_ADOPTING_AGENTS[source.agent]
    )
  }
  if (!isCurrent()) {
    return
  }
  const release = () => {
    if (pending.get(key) === controller) {
      pending.delete(key)
      changed()
    }
  }
  pending.set(key, controller)
  changed()
  const stopSource = useAppStore.subscribe(() => {
    if (!isCurrent()) {
      controller.abort()
      release()
    }
  })
  const timer = setTimeout(
    () => controller.abort(new Error('Conversation preparation timed out.')),
    30_000
  )
  let dispatched = false
  const handoff = () => {
    if (dispatched) {
      return true
    }
    if (!isCurrent()) {
      return false
    }
    dispatched = true
    stopSource()
    clearTimeout(timer)
    return true
  }
  try {
    if (
      target.kind !== 'local' &&
      !(await waitForPromiseWithSignal(
        supportsInPlaceSwitch(target, source.agent),
        controller.signal
      ))
    ) {
      return
    }
    const cliSourceSupported = await waitForPromiseWithSignal(
      supportsStructuredAgentSessionCliSource(target),
      controller.signal
    )
    if (!isCurrent()) {
      return
    }
    const agent = await waitForPromiseWithSignal(
      adoptingAgentOnHost(source.agent, source.workspaceId),
      controller.signal
    )
    if (!isCurrent()) {
      return
    }
    const plan = adoptAgentSessionLaunchVerdict({
      route: 'structured-native-chat',
      requestId: newAgentLaunchRequestId(),
      agent,
      worktreeId: source.workspaceId,
      executionHostId: source.executionHostId,
      resumeFrom: {
        providerSessionId: source.providerSessionId,
        ...(cliSourceSupported
          ? { cliSource: { workspaceId: source.workspaceId, paneKey: source.paneKey } }
          : {})
      }
    })
    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan,
      hooks: { beforeCreate: handoff },
      afterTabId: source.tabId,
      deferPublication: true
    })
    if (!launch) {
      return
    }
    const result = await waitForPromiseWithSignal(launch.settlement, controller.signal)
    if (result.kind === 'structured') {
      retireSwitchedTerminalPane(source)
    } else if (
      result.kind === 'failed' &&
      !result.notified &&
      pending.get(key) === controller &&
      (await reportCliChatResumeFailure(source, result.error, target))
    ) {
      retireSwitchedTerminalPane(source)
    }
  } catch (error) {
    if (
      pending.get(key) === controller &&
      (await reportCliChatResumeFailure(source, error, target))
    ) {
      retireSwitchedTerminalPane(source)
    }
  } finally {
    clearTimeout(timer)
    stopSource()
    release()
  }
}
