import { randomUUID } from 'node:crypto'
import type { CreateWorktreeArgs } from '../shared/worktree/create-types'
import type { ExecutionHostId } from '../shared/execution-host'

export type BranchRenameGrant = {
  branch: string
  instanceId: string
  hostId: ExecutionHostId
}

export function isAutomaticBranchCreation(
  request: Pick<CreateWorktreeArgs, 'branchNaming' | 'nameWasGenerated' | 'branchNameOverride'> & {
    cliProvenance?: { kind: string }
  },
  settings: { autoRenameBranchFromWork?: boolean }
): boolean {
  return (
    settings.autoRenameBranchFromWork === true &&
    !request.branchNameOverride &&
    request.cliProvenance?.kind !== 'created-by-cli' &&
    (request.branchNaming === 'automatic' || request.nameWasGenerated === true)
  )
}

export function generatedBranchSeed(): string {
  return `orca-${randomUUID().slice(0, 8)}`
}

export function sameBranchRenameGrant(
  current: BranchRenameGrant | undefined,
  expected: BranchRenameGrant
): boolean {
  return (
    current?.branch === expected.branch &&
    current.instanceId === expected.instanceId &&
    current.hostId === expected.hostId
  )
}
