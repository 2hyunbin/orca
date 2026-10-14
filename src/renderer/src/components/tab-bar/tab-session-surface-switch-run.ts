import { aiVaultSessionListArgs } from '../right-sidebar/ai-vault-session-list-request'
import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { activateAiVaultStructuredSession } from '@/lib/activate-ai-vault-structured-session'
import { useAppStore } from '@/store'
import { isAiVaultSessionResumableContent } from '../../../../shared/ai-vault-types'
import type {
  AiVaultSessionLaunchContext,
  AiVaultSelectedSessionSource
} from '../../../../shared/ai-vault-selected-session'
import { LEGACY_SELECTED_SESSION_LOOKUP_TIMEOUT_MS } from '../../../../shared/ai-vault-selected-session'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import type { AiVaultSurfaceSwitchOperation } from '@/lib/ai-vault-surface-switch-operation'
import { formatAgentTypeLabel } from '../../../../shared/agent-type-label'
import {
  resolveTabSessionSwitch,
  type TabSessionSelectedSource
} from './tab-session-selected-source'

type Stage = 'loading' | 'opening'
type PendingSwitch = { stage: Stage; controller: AbortController }
const runningSwitches = new Map<string, PendingSwitch>()
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((listener) => listener())

export function isTabStillOpen(tab: { id: string; worktreeId: string }): boolean {
  const state = useAppStore.getState()
  const matches = (candidate: { id: string }) => candidate.id === tab.id
  return (
    (state.tabsByWorktree[tab.worktreeId]?.some(matches) ?? false) ||
    (state.unifiedTabsByWorktree[tab.worktreeId]?.some(matches) ?? false)
  )
}

function subjectKey(subject: TabSessionSelectedSource): string {
  return [
    subject.executionHostId,
    subject.kind,
    subject.agent,
    subject.kind === 'chat' ? subject.sessionId : subject.providerSessionId
  ].join('\0')
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useTabSessionSurfaceSwitchPending(
  subject: TabSessionSelectedSource | null
): Stage | null {
  return useSyncExternalStore(
    subscribe,
    () => (subject ? (runningSwitches.get(subjectKey(subject))?.stage ?? null) : null),
    () => null
  )
}

function sourceIdentityIsCurrent(
  subject: TabSessionSelectedSource,
  tab: { id: string; worktreeId: string }
): boolean {
  if (!isTabStillOpen(tab)) {
    return false
  }
  if (subject.kind === 'chat') {
    const source = useAppStore
      .getState()
      .unifiedTabsByWorktree[tab.worktreeId]?.find((candidate) => candidate.id === tab.id)
    return source?.contentType === 'agent-session' && source.entityId === subject.sessionId
  }
  const current = useAppStore.getState().agentStatusByPaneKey[subject.paneKey]
  return (
    current?.agentType === subject.agent &&
    current.providerSession?.id === subject.providerSessionId
  )
}

export function tabSessionSwitchPendingLabel(stage: Stage): string {
  return stage === 'loading'
    ? translate('components.tabBar.sessionSwitch.loading', 'Loading conversation…')
    : translate('components.tabBar.sessionSwitch.opening', 'Opening…')
}

function notifyFailure(subject: TabSessionSelectedSource, error: unknown): void {
  toast.error(
    subject.kind === 'chat'
      ? translate(
          'auto.components.right.sidebar.AiVaultPanel.resumeInNewCliFailed',
          'Could not resume this session in a new CLI.'
        )
      : translate(
          'auto.components.right.sidebar.AiVaultPanel.resumeInChatFailed',
          'Could not resume this session in a new chat.'
        ),
    error instanceof Error && error.message ? { description: error.message } : undefined
  )
}

export async function runTabSessionSurfaceSwitch(args: {
  subject: TabSessionSelectedSource
  sourceTab: { id: string; worktreeId: string }
  intent?: 'new-chat' | 'open-or-resume-chat'
  launch: (
    row: AiVaultSessionLaunchContext,
    worktreeId: string,
    operation: AiVaultSurfaceSwitchOperation
  ) => Promise<void>
}): Promise<void> {
  const { subject, sourceTab } = args
  const key = subjectKey(subject)
  if (runningSwitches.has(key) || !sourceIdentityIsCurrent(subject, sourceTab)) {
    return
  }
  const owner: PendingSwitch = { stage: 'loading', controller: new AbortController() }
  const requestToken = createBrowserUuid()
  const release = () => {
    if (runningSwitches.get(key) === owner) {
      runningSwitches.delete(key)
      changed()
    }
  }
  const abandon = () => {
    owner.controller.abort()
    release()
    void window.api.aiVault.cancelResolveSession({ requestToken }).catch(() => undefined)
  }
  runningSwitches.set(key, owner)
  changed()
  const stopWatching = useAppStore.subscribe(() => {
    if (!sourceIdentityIsCurrent(subject, sourceTab)) {
      abandon()
    }
  })
  const host = subject.executionHostId
  const timer = setTimeout(() => {
    owner.controller.abort(new Error('Conversation lookup timed out.'))
    release()
    void window.api.aiVault.cancelResolveSession({ requestToken }).catch(() => undefined)
  }, LEGACY_SELECTED_SESSION_LOOKUP_TIMEOUT_MS)
  try {
    const source: AiVaultSelectedSessionSource =
      subject.kind === 'chat'
        ? { kind: 'chat', workspaceId: subject.workspaceId, sessionId: subject.sessionId }
        : {
            kind: 'cli',
            workspaceId: subject.workspaceId,
            paneKey: subject.paneKey,
            agent: subject.agent,
            providerSessionId: subject.providerSessionId
          }
    const result = await waitForPromiseWithSignal(
      window.api.aiVault.resolveSession({
        source,
        executionHostId: host,
        requestToken,
        legacyList: aiVaultSessionListArgs(subject.legacyListRequest, { requestToken })
      }),
      owner.controller.signal
    )
    clearTimeout(timer)
    if (!sourceIdentityIsCurrent(subject, sourceTab)) {
      return
    }
    if (result.status === 'cancelled') {
      throw new Error('Conversation lookup was cancelled.')
    }
    const row = result.status === 'ready' ? result.session : null
    if (subject.kind === 'cli' && row?.structuredSession) {
      if (args.intent === 'open-or-resume-chat') {
        owner.stage = 'opening'
        changed()
        await waitForPromiseWithSignal(
          activateAiVaultStructuredSession(row),
          owner.controller.signal
        )
      } else {
        toast.error(
          translate(
            'auto.components.right.sidebar.AiVaultPanel.resumeInChatConflict',
            'Another chat is already holding this conversation.'
          )
        )
      }
      return
    }
    if (!row || !isAiVaultSessionResumableContent(row)) {
      toast.error(
        translate(
          'components.native-chat.resumeInNewChat.notSavedYet',
          "{{agent}} hasn't saved this conversation yet. Try again after it replies.",
          { agent: formatAgentTypeLabel(subject.agent) }
        )
      )
      return
    }
    const move = resolveTabSessionSwitch(useAppStore.getState(), row, subject)
    if (!move) {
      toast.error(
        subject.kind === 'chat'
          ? translate(
              'auto.components.right.sidebar.AiVaultPanel.resumeInNewCliUnavailable',
              'This session cannot be opened in the CLI.'
            )
          : translate(
              'components.native-chat.resumeInNewChat.cannotResume',
              "This {{agent}} conversation can't be resumed in a native chat.",
              { agent: formatAgentTypeLabel(subject.agent) }
            )
      )
      return
    }
    owner.stage = 'opening'
    changed()
    await waitForPromiseWithSignal(
      args.launch(row, move.worktreeId, {
        signal: owner.controller.signal,
        isSourceOpen: () =>
          !owner.controller.signal.aborted && sourceIdentityIsCurrent(subject, sourceTab)
      }),
      owner.controller.signal
    )
  } catch (error) {
    if (sourceIdentityIsCurrent(subject, sourceTab)) {
      notifyFailure(subject, error)
    }
  } finally {
    clearTimeout(timer)
    stopWatching()
    release()
  }
}
