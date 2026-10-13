import type { Store } from './persistence'
import { getEphemeralVmRecipeResultConnection } from '../shared/ephemeral-vm-recipes'
import {
  getEphemeralVmRecipeResultWarnings,
  redactEphemeralVmRecipeDiagnosticText,
  type EphemeralVmRecipeResultWarning
} from '../shared/ephemeral-vm-recipe-diagnostics'
import { getProvisionedRootRecipeRepoUrl } from '../shared/ephemeral-vm-recipe-repo-url'
import { updateEphemeralVmRuntimeStatus } from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import { addEnvironmentFromPairingCode } from '../shared/runtime-environment-store'
import {
  redactRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../shared/runtime-environments'
import {
  cleanupEphemeralVmRuntime,
  provisionEphemeralVmRuntime
} from './ephemeral-vm-runtime-service'
import { connectRuntimeOwnedSshTarget } from './ephemeral-vm-runtime-ssh'
import { getRecipeRepo, resolveRecipeForRepo } from './ipc/ephemeral-vm-recipe-context'
import { resolveProvisionedRootSource } from './ephemeral-vm-provisioned-root-source'

import type { OrcaVmRecipe } from '../shared/orca-yaml-hook-types'
export type EphemeralVmProvisionIpcResult =
  | {
      ok: true
      connectionType: 'orca-server'
      runtime: EphemeralVmRuntimeRecord
      environment: PublicKnownRuntimeEnvironment
      stderr: string
      warnings: EphemeralVmRecipeResultWarning[]
    }
  | {
      ok: true
      connectionType: 'ssh'
      runtime: EphemeralVmRuntimeRecord
      sshTargetId: string
      /** The managed Orca server the host runs; its workspace lives there. */
      environmentId?: string
      expectedRefHead?: string
      stderr: string
      warnings: EphemeralVmRecipeResultWarning[]
    }
  | {
      ok: false
      error: string
      stderr: string
      stdout: string
    }

export type RecipeEnvironmentProvisionArgs = {
  repoId: string
  recipeId: string
  workspaceName?: string
  projectId?: string
  workspaceId?: string
  branch?: string
  ref?: string
}

export async function provisionRecipeEnvironment(
  store: Store,
  userDataPath: string,
  args: RecipeEnvironmentProvisionArgs,
  pluginRecipes: readonly OrcaVmRecipe[],
  options: {
    signal?: AbortSignal
    onStdout?: (chunk: string) => void
    onStderr?: (chunk: string) => void
  } = {}
): Promise<EphemeralVmProvisionIpcResult> {
  const repo = getRecipeRepo(store, args.repoId)
  if (!repo.ok) {
    return { ok: false, error: repo.message, stdout: '', stderr: '' }
  }
  const recipe = resolveRecipeForRepo(repo.repo.path, args.recipeId, pluginRecipes)
  if (!recipe) {
    return { ok: false, error: `Recipe not found: ${args.recipeId}`, stdout: '', stderr: '' }
  }
  let recipeRepoUrl = repo.repo.gitRemoteIdentity?.remoteUrl
  let sourceRef = args.ref
  let expectedRefHead: string | undefined
  if (recipe.checkoutMode === 'provisioned-root') {
    const source = await resolveProvisionedRootSource(store, repo.repo, args.ref, options.signal)
    if (options.signal?.aborted) {
      return { ok: false, error: 'Provisioning cancelled.', stdout: '', stderr: '' }
    }
    if (!source) {
      return {
        ok: false,
        error: args.ref
          ? `Could not resolve provisioned-root start ref: ${args.ref}`
          : 'Could not resolve a default provisioned-root start ref.',
        stdout: '',
        stderr: ''
      }
    }
    sourceRef = source.ref
    expectedRefHead = source.head
    recipeRepoUrl = source.remoteUrl ?? recipeRepoUrl
  }
  const repoUrl = getProvisionedRootRecipeRepoUrl(recipe.checkoutMode, recipeRepoUrl)
  const result = await provisionEphemeralVmRuntime({
    userDataPath: userDataPath,
    repoPath: repo.repo.path,
    repoId: repo.repo.id,
    recipe,
    projectId: args.projectId,
    workspaceId: args.workspaceId,
    workspaceName: args.workspaceName,
    ...(repoUrl ? { repoUrl } : {}),
    ...(args.branch ? { branch: args.branch } : {}),
    ...(sourceRef ? { ref: sourceRef } : {}),
    ...(expectedRefHead ? { expectedRefHead } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    onStdout: options.onStdout,
    onStderr: options.onStderr
  })
  if (!result.ok) {
    return {
      ok: false,
      error: result.start.error,
      stdout: redactEphemeralVmRecipeDiagnosticText(result.start.stdout),
      stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr)
    }
  }
  const connection = getEphemeralVmRecipeResultConnection(result.start.result)
  if (connection.type === 'ssh') {
    try {
      const ssh = await connectRuntimeOwnedSshTarget({
        runtimeId: result.runtime.id,
        connection
      })
      const runtime = updateEphemeralVmRuntimeStatus(userDataPath, result.runtime.id, {
        sshTargetId: ssh.targetId,
        runtimeEnvironmentId: ssh.environmentId
      })
      return {
        ok: true,
        connectionType: 'ssh',
        runtime,
        sshTargetId: ssh.targetId,
        environmentId: ssh.environmentId,
        ...(expectedRefHead ? { expectedRefHead } : {}),
        stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr),
        warnings: getEphemeralVmRecipeResultWarnings(result.start.result)
      }
    } catch (error) {
      await cleanupEphemeralVmRuntime({
        userDataPath: userDataPath,
        repoPath: repo.repo.path,
        recipe,
        runtimeId: result.runtime.id
      }).catch(() => undefined)
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        stdout: redactEphemeralVmRecipeDiagnosticText(result.start.stdout),
        stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr)
      }
    }
  }

  let environment: ReturnType<typeof addEnvironmentFromPairingCode>
  try {
    environment = addEnvironmentFromPairingCode(userDataPath, {
      name: buildEphemeralEnvironmentName(repo.repo.displayName, result.runtime.id),
      pairingCode: connection.pairingCode,
      source: 'ephemeral-vm'
    })
  } catch (error) {
    await cleanupEphemeralVmRuntime({
      userDataPath: userDataPath,
      repoPath: repo.repo.path,
      recipe,
      runtimeId: result.runtime.id
    }).catch(() => undefined)
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stdout: redactEphemeralVmRecipeDiagnosticText(result.start.stdout),
      stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr)
    }
  }
  const runtime = updateEphemeralVmRuntimeStatus(userDataPath, result.runtime.id, {
    runtimeEnvironmentId: environment.id
  })
  return {
    ok: true,
    connectionType: 'orca-server',
    runtime,
    environment: redactRuntimeEnvironment(environment),
    stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr),
    warnings: getEphemeralVmRecipeResultWarnings(result.start.result)
  }
}

function buildEphemeralEnvironmentName(repoName: string, runtimeId: string): string {
  return `${repoName} VM ${runtimeId.slice(-8)}`
}
