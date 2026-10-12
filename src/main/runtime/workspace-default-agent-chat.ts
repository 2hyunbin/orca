/**
 * The chat a deliberately activated, empty workspace opens with: the window's rule
 * (renderer `empty-workspace-default-agent-chat.ts`), run where the runtime now seeds the workspace.
 * False means nothing opened and the caller seeds the shell.
 */

import { randomUUID } from 'node:crypto'
import { isNativeChatEnabled } from '../../shared/structured-native-chat-launch-route'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { TuiAgent } from '../../shared/tui-agent'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { pickTuiAgent } from '../../shared/tui-agent-selection'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import { getRepoSshConnectionId } from '../../shared/execution-host'
import { workspaceKindForWorktreeId } from '../../shared/workspace-launch-kind'
import { createStructuredAgentSessionId } from '../../shared/structured-agent-session-create'
import { createStructuredAgentSessionOperationId } from '../../shared/structured-agent-session-mutation'
import { detectAgentsOnHost } from '../preflight/workspace-agent-detection'
import {
  decideAgentLaunchMode,
  readAgentLaunchModeSettings,
  resolveAgentLaunchModeOnHost
} from '../agent-launch/agent-launch-mode'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { OrcaRuntimeService } from './orca-runtime'
import { createStructuredAgentSessionForWorktree } from './rpc/methods/structured-agent-session-create'

// Why bounded: detection only decides chat vs shell, so a slow host must not hold the workspace empty.
const DEFAULT_CHAT_DETECTION_TIMEOUT_MS = 5_000

export type WorkspaceDefaultAgentChatPorts = {
  settings: Partial<
    Pick<GlobalSettings, 'experimentalNativeChat' | 'defaultTuiAgent' | 'disabledTuiAgents'>
  > | null
  detectAgents: () => Promise<string[]>
  opensAsChat: (agent: TuiAgent) => Promise<boolean>
  createChat: (agent: TuiAgent) => Promise<void>
}

export async function openWorkspaceDefaultAgentChat(
  ports: WorkspaceDefaultAgentChatPorts
): Promise<boolean> {
  const { settings } = ports
  // Why: a 'blank' default means the user wants workspaces to open without an agent.
  if (!isNativeChatEnabled(settings) || settings?.defaultTuiAgent === 'blank') {
    return false
  }
  const detected = await withTimeout<string[]>(
    ports.detectAgents().catch(() => []),
    DEFAULT_CHAT_DETECTION_TIMEOUT_MS,
    []
  )
  const agent = pickTuiAgent(
    settings?.defaultTuiAgent,
    detected.filter(isTuiAgent),
    settings?.disabledTuiAgents
  )
  // Why: an agent that can only open as a TUI here would replace the shell with a process nobody asked for.
  if (!agent || !(await ports.opensAsChat(agent))) {
    return false
  }
  try {
    await ports.createChat(agent)
    return true
  } catch (error) {
    console.warn(
      `[worktree-create] The default ${agent} chat did not open; seeding a shell:`,
      error
    )
    return false
  }
}

/** The window's rule against this runtime's settings, agent detection and structured sessions. */
export function openRuntimeWorkspaceDefaultAgentChat(
  runtime: OrcaRuntimeService,
  repo: Repo,
  worktreeId: string
): Promise<boolean> {
  const settings = readAgentLaunchModeSettings(runtime)
  const sshConnectionId = getRepoSshConnectionId(repo)
  return openWorkspaceDefaultAgentChat({
    settings,
    detectAgents: () =>
      detectAgentsOnHost(
        sshConnectionId ? { kind: 'ssh', connectionId: sshConnectionId } : { kind: 'local' }
      ),
    opensAsChat: async (agent) => {
      const preflight = decideAgentLaunchMode({
        placement: { agent, workspaceKind: workspaceKindForWorktreeId(worktreeId) },
        settings
      })
      const receipt = await resolveAgentLaunchModeOnHost(runtime, preflight, worktreeId, agent)
      return receipt.mode === 'structured'
    },
    createChat: async (agent) => {
      const created = await createStructuredAgentSessionForWorktree({
        runtime,
        ensureHost: async () => {
          await runtime.ensureStructuredAgentSessionHost()
          const host = getStructuredAgentSessionHost()
          if (!host) {
            throw new Error('structured_agent_session_unsupported')
          }
          return host
        },
        caller: { callerKey: `workspace-default-chat:${worktreeId}` },
        envelope: {
          sessionId: createStructuredAgentSessionId(agent, randomUUID),
          clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
          expectedRuntimeFence: null,
          // Overwritten by `prepare`; no client operation id is replayed here.
          payloadFingerprint: ''
        },
        worktree: `id:${worktreeId}`,
        agent,
        activate: true
      })
      if (!created.ok) {
        throw new Error(created.refusal.code)
      }
    }
  })
}
