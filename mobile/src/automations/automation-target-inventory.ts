import { z } from 'zod'
import { getRepoMainWorktreeId } from '../../../src/shared/worktree/id'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../src/shared/execution-host'
import type { AutomationDestination } from '../../../src/shared/automation-owner-precondition'
import { buildWorkspaceRunContext } from '../../../src/shared/task-source-context'
import {
  newTabRepoListRead,
  preflightDetectAgentsRead,
  preflightDetectRemoteAgentsRead
} from '../session/mobile-session-read-operations'
import { newTabSettingsRead } from '../transport/settings-read-operations'
import { buildMobileNewTabAgentOptions } from '../session/mobile-new-tab-agent-options'
import { loadMobileAgentLaunchContext } from '../session/mobile-new-tab-agent-loader'
import type { RpcClient } from '../transport/rpc-client'
import {
  automationWorkspacesRead,
  automationProjectsRead,
  automationSetupsRead,
  automationSshTargetsRead
} from './automation-operations'
import {
  workspaceSchema,
  type AutomationSetup,
  type AutomationWorkspace
} from './automation-reply-schema'

const repoSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  path: z.string(),
  kind: z.string().optional(),
  connectionId: z.string().nullish(),
  executionHostId: z.string().nullish()
})
const agentSettingsSchema = z.object({
  defaultTuiAgent: z.unknown().optional(),
  disabledTuiAgents: z.unknown().optional()
})

export async function loadAutomationTargets(client: RpcClient, limit = 200) {
  const [projects, setups, catalog, repos, ssh] = await Promise.all([
    automationProjectsRead.request(client),
    automationSetupsRead.request(client),
    automationWorkspacesRead.request(client, { limit }),
    newTabRepoListRead.request(client),
    automationSshTargetsRead.request(client)
  ])
  const workspaceReply = automationWorkspacesRead.interpret(catalog)
  const repoRows = newTabRepoListRead.interpret(repos).flatMap((raw) => {
    const parsed = repoSchema.safeParse(raw)
    return parsed.success ? [parsed.data] : []
  })
  const projectRows = automationProjectsRead.interpret(projects).projects
  return {
    setups: automationSetupsRead
      .interpret(setups)
      .setups.filter(
        (setup) =>
          setup.setupState === 'ready' &&
          repoRows.some(
            (repo) =>
              repo.id === setup.repoId &&
              repo.path === setup.path &&
              getRepoExecutionHostId(repo) === setup.hostId
          )
      )
      .map((setup) => ({
        ...setup,
        label:
          projectRows.find((project) => project.id === setup.projectId)?.displayName ??
          setup.displayName,
        kind:
          setup.kind ??
          repoRows.find(
            (repo) =>
              repo.id === setup.repoId &&
              repo.path === setup.path &&
              getRepoExecutionHostId(repo) === setup.hostId
          )?.kind
      })),
    workspaces: workspaceReply.worktrees.flatMap((raw) => {
      const row = z.object({ id: z.string() }).passthrough().safeParse(raw)
      const parsed = workspaceSchema.safeParse(
        row.success ? { ...row.data, worktreeId: row.data.id } : raw
      )
      return parsed.success && !parsed.data.isArchived ? [parsed.data] : []
    }),
    coverage: {
      limit,
      totalCount: workspaceReply.totalCount,
      truncated: workspaceReply.truncated,
      hostScope: workspaceReply.hostScope
    },
    sshTargets: automationSshTargetsRead.interpret(ssh).targets
  }
}
export type AutomationTargets = Awaited<ReturnType<typeof loadAutomationTargets>>

export function automationTargetDestination(
  setup: AutomationSetup,
  workspace: AutomationWorkspace | undefined,
  targets: AutomationTargets
): AutomationDestination {
  const host = parseExecutionHostId(workspace?.hostId ?? setup.hostId)
  if (host?.kind === 'local') {
    return { selector: { kind: 'self' } }
  }
  if (host?.kind === 'ssh') {
    const target = targets.sshTargets.find((entry) => entry.id === host.targetId)
    if (target?.generation) {
      return { selector: { kind: 'ssh', targetId: target.id, targetGeneration: target.generation } }
    }
  }
  throw new Error('Select a project on this host or one of its registered SSH hosts.')
}

export function automationTargetContext(setup: AutomationSetup) {
  return buildWorkspaceRunContext({
    projectId: setup.projectId,
    hostId: setup.hostId,
    projectHostSetupId: setup.id,
    repoId: setup.repoId,
    path: setup.path
  })
}

export async function loadAutomationAgents(
  client: RpcClient,
  setup: AutomationSetup,
  workspaceId?: string
) {
  const host = parseExecutionHostId(setup.hostId)
  if (workspaceId && host?.kind !== 'ssh') {
    const context = await loadMobileAgentLaunchContext({
      client,
      worktreeId: workspaceId,
      hostRefusesOtherRuntime: true
    })
    const settings = agentSettingsSchema.safeParse(context.settings)
    return buildMobileNewTabAgentOptions(
      { disabledTuiAgents: settings.success ? settings.data.disabledTuiAgents : undefined },
      context.detectedAgents
    )
  }
  const detection =
    host?.kind === 'ssh'
      ? preflightDetectRemoteAgentsRead.request(client, { connectionId: host.targetId })
      : preflightDetectAgentsRead.request(client, {
          worktreeId: getRepoMainWorktreeId({ id: setup.repoId, path: setup.path })
        })
  const [settingsReply, detectedReply] = await Promise.all([
    newTabSettingsRead.request(client),
    detection
  ])
  const settings = agentSettingsSchema.safeParse(newTabSettingsRead.interpret(settingsReply)())
  const detected =
    host?.kind === 'ssh'
      ? preflightDetectRemoteAgentsRead.interpret(detectedReply)
      : preflightDetectAgentsRead.interpret(detectedReply)
  const defaultAgent = settings.success ? settings.data.defaultTuiAgent : undefined
  const available = buildMobileNewTabAgentOptions(
    { disabledTuiAgents: settings.success ? settings.data.disabledTuiAgents : undefined },
    detected
  )
  return [
    ...available.filter((entry) => entry.agent === defaultAgent),
    ...available.filter((entry) => entry.agent !== defaultAgent)
  ]
}

export function automationSetupKey(
  setup: Pick<AutomationSetup, 'id' | 'hostId' | 'repoId' | 'path'>
): string {
  return JSON.stringify([setup.hostId, setup.id, setup.repoId, setup.path])
}
export function workspaceMatchesSetup(
  workspace: AutomationWorkspace,
  setup: AutomationSetup
): boolean {
  return workspace.repoId === setup.repoId && (workspace.hostId ?? 'local') === setup.hostId
}
