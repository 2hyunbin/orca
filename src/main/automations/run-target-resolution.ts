import type { Store } from '../persistence'
import type { Automation } from '../../shared/automations-types'
import { getAutomationLegacyRepoId } from '../../shared/automation-run-identity'
import {
  AUTOMATION_ORPHAN_ISSUES,
  type AutomationCapturedHostIssue
} from '../../shared/automation-list-scope'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import type { ProjectHostSetup } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { buildWorkspaceRunContext } from '../../shared/task-source-context'

export type AutomationRunTargetResult =
  | { ok: true; cwd: string; repo: Repo; setup?: ProjectHostSetup }
  | { ok: false; error: string }

/**
 * One fixed sentence per diagnosis, and never the same sentence twice: run
 * coalescing folds repeats on identical error text, so a message that varied per
 * occurrence would write a row each, and a shared one would merge a host that is
 * gone with a host that was replaced.
 */
const CAPTURED_HOST_REFUSALS: Record<AutomationCapturedHostIssue, string> = {
  [AUTOMATION_ORPHAN_ISSUES.targetMissing]:
    'The automation host is no longer registered, so this automation has nowhere to run.',
  [AUTOMATION_ORPHAN_ISSUES.targetReplaced]:
    'The automation host was removed and re-registered, so this automation must be re-adopted before it can run.',
  [AUTOMATION_ORPHAN_ISSUES.workspaceHostAmbiguous]:
    'The automation workspace spans more than one host, so Orca cannot tell which one to run it on.'
}

const NO_RUNNABLE_HOST = 'This automation has no host to run on.'

type AutomationRunTargetOptions = {
  allowRemoteHostScheduling?: boolean
}

function getLegacyPrecheckCwd(store: Store, automation: Automation): string | null {
  if (automation.workspaceMode === 'existing') {
    const parsed = automation.workspaceId
      ? splitWorktreeIdForFilesystem(automation.workspaceId)
      : null
    return parsed?.worktreePath ?? null
  }
  return store.getRepo(getAutomationLegacyRepoId(automation))?.path ?? null
}

function resolveAutomationOwnerRefusal(store: Store, automation: Automation): string | null {
  if (store.automationOwnerPrecondition(automation.id)?.selector.kind !== 'orphan') {
    return null
  }
  const issue = store.automationCapturedHostIssue(automation)
  return issue ? CAPTURED_HOST_REFUSALS[issue] : NO_RUNNABLE_HOST
}

const LEGACY_TWIN_REFUSAL =
  'This automation was saved before Orca tracked which host it runs on, and its project is on more than one host. Open the automation and pick the host it should run on.'

/** A record with no captured run target names its project by repo id alone. */
function resolveLegacyAutomationRunTarget(
  store: Store,
  automation: Automation,
  options: AutomationRunTargetOptions
): AutomationRunTargetResult {
  const repoId = getAutomationLegacyRepoId(automation)
  const rows = store.getRepos().filter((entry) => entry.id === repoId)
  // Why first: `getRepo(id)`, and the owner verdict below, would silently pick one twin's host.
  if (rows.length > 1) {
    return { ok: false, error: LEGACY_TWIN_REFUSAL }
  }
  const ownerRefusal = resolveAutomationOwnerRefusal(store, automation)
  if (ownerRefusal) {
    return { ok: false, error: ownerRefusal }
  }
  const repo = rows[0]
  const cwd = getLegacyPrecheckCwd(store, automation)
  if (!repo || !cwd) {
    return { ok: false, error: 'Automation run target is no longer available.' }
  }
  stampResolvableRunContext(store, automation, repo, options)
  return { ok: true, cwd, repo }
}

/**
 * Captures the one host a legacy record resolves to, so a twin added later cannot make it
 * ambiguous. Stamps only a context the captured-target path accepts, so this never changes
 * whether the record runs.
 */
function stampResolvableRunContext(
  store: Store,
  automation: Automation,
  repo: Repo,
  options: AutomationRunTargetOptions
): void {
  const repoHostId = getRepoExecutionHostId(repo)
  const setup = store
    .getProjectHostSetups()
    .find((candidate) => candidate.repoId === repo.id && candidate.hostId === repoHostId)
  if (!setup) {
    return
  }
  const runContext = buildWorkspaceRunContext({
    projectId: setup.projectId,
    hostId: setup.hostId,
    projectHostSetupId: setup.id,
    repoId: repo.id,
    path: setup.path
  })
  if (!runContext) {
    return
  }
  const stamped = { ...automation, runContext }
  if (resolveAutomationRunTarget(store, stamped, options).ok) {
    store.stampLegacyAutomationRunContext(automation.id, runContext)
  }
}

export function resolveAutomationRunTarget(
  store: Store,
  automation: Automation,
  options: AutomationRunTargetOptions = {}
): AutomationRunTargetResult {
  const context = automation.runContext ?? null
  if (!context) {
    return resolveLegacyAutomationRunTarget(store, automation, options)
  }
  const parsedHost = parseExecutionHostId(context.hostId)
  if (
    parsedHost?.kind === 'runtime' &&
    (!options.allowRemoteHostScheduling || automation.schedulerOwner !== 'remote_host_service')
  ) {
    return {
      ok: false,
      error:
        'Remote-server automation scheduling is not available from this Orca client yet. Run this automation on the remote server or update Orca when durable remote scheduling is available.'
    }
  }

  // Why: removing a host — or removing and re-registering it under the same id —
  // keeps hostId, repoId and path intact, so every check below still passes while
  // the host is gone or is a different machine. Asks the list's projection for the
  // verdict rather than re-deriving one, so the row the user sees as orphaned can
  // never be the row that quietly keeps firing.
  const hostIssue = store.automationCapturedHostIssue(automation)
  if (hostIssue) {
    return { ok: false, error: CAPTURED_HOST_REFUSALS[hostIssue] }
  }

  const setup = store
    .getProjectHostSetups()
    .find((candidate) => candidate.id === context.projectHostSetupId)
  if (!setup) {
    return {
      ok: false,
      error: 'Project is not set up on the selected automation host anymore.'
    }
  }
  if (setup.setupState !== 'ready') {
    return {
      ok: false,
      error: `Project setup on the selected automation host is ${setup.setupState}.`
    }
  }
  // Why: projectId is a derived identity that upgrades over time (repo:→git:→github:);
  // matching on it strands automations created before their repo's identity resolved.
  // Anchor on repoId/hostId/path instead — the durable, stable target identity.
  if (setup.hostId !== context.hostId || setup.repoId !== context.repoId) {
    return {
      ok: false,
      error: 'Automation run target no longer matches the selected project host setup.'
    }
  }

  const repo = store.getRepo(context.repoId)
  if (!repo) {
    return {
      ok: false,
      error: 'Repository for the selected automation host is no longer available.'
    }
  }
  if (getRepoExecutionHostId(repo) !== context.hostId) {
    return {
      ok: false,
      error: 'Repository is no longer attached to the selected automation host.'
    }
  }
  if (repo.path !== setup.path || context.path !== setup.path) {
    return {
      ok: false,
      error: 'Project path for the selected automation host has changed.'
    }
  }

  return { ok: true, cwd: setup.path, repo, setup }
}
