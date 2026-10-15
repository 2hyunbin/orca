/** The execution host chooses and creates the worker through the shared launch executor. */

import type { AgentLaunchPreferences } from '../../../../../../shared/agent-session-host-authority'
import type { AgentLaunchResult } from '../../../../../../shared/agent-launch-intent'
import { tearDownFailedWorkerStart } from '../worker/failed-worker-start-teardown'
import { workerWorktreeLaunchInputs } from '../worker/worker-worktree-launch-inputs'
import { createStructuredWorkerSessionForWorktree } from '../worker/worker-topology'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import { executeAgentLaunch } from '../../../../../agent-launch/agent-launch-executor'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { WORKER_START_VOCABULARY } from '../../orchestration-worker-start-mode'
import type { WorkerSetupReceipt } from '../worker/worker-topology'
import {
  appendFederationSetupEffect,
  appendFederationTerminalEffects,
  type FederationEffect
} from './federation-effects'
import type { FederationAttachStartInput } from './federation-start-schema'

export type FederatedStructuredSession = Awaited<
  ReturnType<typeof createStructuredWorkerSessionForWorktree>
>

export type FederatedAgentPlacement = {
  worktree: { id: string }
  terminalHandle: string
  structuredSession: FederatedStructuredSession | null
  agentSession: AgentLaunchResult['outcome']
  mode: AgentLaunchResult['receipt']
}

export async function launchFederatedWorkerAgent(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  params: FederationAttachStartInput
  agent: TuiAgent | undefined
  launchPreferences: AgentLaunchPreferences | undefined
  /** The workspace to start in; absent creates the new top-level worktree the params describe. */
  worktree?: { id: string }
  setupSource: string
  effects: FederationEffect[]
  /** The created worktree's setup receipt, as soon as it exists, so a later failure reports it. */
  onSetup: (setup: WorkerSetupReceipt) => void
  onStage: (stage: 'worktree_create' | 'terminal_create') => void
}): Promise<FederatedAgentPlacement> {
  const { runtime, db, params, effects } = args
  if (!args.agent) {
    // Validation refuses a fresh launch with no agent; this only narrows the type.
    throw new Error(
      'A configured --agent is required when federated worker-start creates a terminal.'
    )
  }
  const agent = args.agent
  let created: { id: string } | undefined
  let structuredSession: FederatedStructuredSession | null = null
  let launched: AgentLaunchResult
  try {
    launched = await executeAgentLaunch({
      runtime,
      intent: {
        agent,
        // Federation's own factory builds the create from the attachment, so the target carries none.
        target: args.worktree
          ? { kind: 'existing', worktree: args.worktree.id }
          : { kind: 'create-worktree', create: {} },
        launchSource: 'orchestration',
        nativeChatDefault: params.nativeChatDefault
      },
      terminalOnly: !params.supportsAgentSession,
      vocabulary: WORKER_START_VOCABULARY,
      onStage: (stage) =>
        args.onStage(stage === 'worktree_create' ? 'worktree_create' : 'terminal_create'),
      workspaces: {
        createRecoveryShell: async (worktreeId) => {
          const shell = await runtime.createTerminal(`id:${worktreeId}`, { surfaceOwner: false })
          effects.push({
            kind: 'terminal',
            role: 'recovery_shell',
            action: 'created',
            id: shell.handle,
            tabId: shell.tabId
          })
        },
        createWorktree: async (launch) => {
          const { repo, name } = params
          if (!repo || !name) {
            // Validation refuses this before the attachment exists; this only narrows the types.
            throw new Error(
              'A remote new-top-level worktree requires --name and an explicit --repo.'
            )
          }
          db.recordRemoteAttachmentStage({
            dispatchId: params.dispatchId,
            stage: 'worktree_creating'
          })
          const setupDecision = params.setup ?? 'run'
          const result = await runtime.createManagedWorktree({
            repoSelector: repo,
            name,
            baseBranch: params.baseBranch,
            displayName: params.displayName,
            displayNameKind: params.displayNameKind,
            comment: params.comment,
            ...workerWorktreeLaunchInputs(launch, {
              agent,
              setupDecision,
              launchPreferences: args.launchPreferences
            }),
            lineage: { noParent: true }
          })
          created = result.worktree
          const terminalHandle = result.startupTerminal?.handle
          effects.push({ kind: 'worktree', action: 'created_top_level', id: result.worktree.id })
          const setup: WorkerSetupReceipt = {
            requested: setupDecision,
            effective: setupDecision,
            source: args.setupSource,
            hookFound: result.setupReceipt?.hookFound ?? false,
            startupPolicy: result.setupReceipt?.startupPolicy ?? 'start-immediately',
            state: result.setupReceipt?.state ?? 'not_configured'
          }
          args.onSetup(setup)
          if (launch.startupAgent && !terminalHandle) {
            throw new Error(result.warning ?? 'Agent-first worktree creation returned no terminal.')
          }
          const listed = await runtime.listTerminals(`id:${result.worktree.id}`, undefined, {
            includeVisualLayouts: false
          })
          appendFederationTerminalEffects(
            effects,
            listed.terminals,
            terminalHandle,
            result.setupReceipt?.terminalHandle
          )
          appendFederationSetupEffect(effects, setup)
          return { worktreeId: result.worktree.id, startupTerminalHandle: terminalHandle }
        }
      },
      surfaces: {
        createStructuredSession: async ({ worktreeId }) => {
          structuredSession = await createStructuredWorkerSessionForWorktree({
            runtime,
            worktreeId,
            agent,
            dispatchId: params.dispatchId,
            launchPreferences: args.launchPreferences,
            effects
          })
          return {
            sessionId: structuredSession.identity.sessionId,
            handle: structuredSession.identity.handle,
            fence: structuredSession.fence
          }
        },
        createTerminalAgent: async ({ worktreeId }) => {
          const terminal = await runtime.createTerminal(`id:${worktreeId}`, {
            // Why: agent ids are not shell commands (`cursor` is the desktop app,
            // its CLI is `cursor-agent`); resolve through the TUI agent config.
            startupAgent: agent,
            launchSource: 'orchestration',
            ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {}),
            title: `worker-${params.taskId}`,
            presentation: 'background'
          })
          effects.push({ kind: 'terminal', role: 'agent', action: 'created', id: terminal.handle })
          return { handle: terminal.handle }
        }
      }
    })
  } catch (error) {
    await tearDownFailedWorkerStart({ runtime, structuredSession, dispatchId: params.dispatchId })
    throw error
  }
  const worktree = args.worktree ?? created
  if (!worktree) {
    throw new Error('Federated worker topology did not resolve.')
  }
  return {
    worktree,
    terminalHandle: launched.outcome.handle,
    structuredSession,
    agentSession: launched.outcome,
    mode: launched.receipt
  }
}
