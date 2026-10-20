import { join } from 'node:path'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  admitRepositoryCheckout,
  type RepositoryCheckoutAdmission,
  type SavedClaimRule
} from '../repository-checkout-admission'
import { wslHostsGateOpen } from './wsl-host-gate'
import { getWslHostService } from './wsl-host-service-instance'

export type PlacementStore = {
  getRepos(): Repo[]
  getSettings?(): Pick<GlobalSettings, 'experimentalWslHosts'>
}

/** Who asks, supplied by the caller boundary: desktop and local CLI place on the local domain. */
export type PlacementCaller = {
  domain: ExecutionHostId | null
  /** A paired client cannot address an environment saved only on this Windows desktop. */
  fromPairedClient: boolean
}

export type RegistrationCaller = Pick<PlacementCaller, 'fromPairedClient'>

/** In-process callers name no client; like an unidentified transport they never start a WSL host. */
export const UNNAMED_REGISTRATION_CALLER: RegistrationCaller = { fromPairedClient: true }

export function registrationDomain(
  caller: RegistrationCaller,
  executionHostId?: ExecutionHostId | null
): ExecutionHostId | null {
  return executionHostId ?? (caller.fromPairedClient ? null : LOCAL_EXECUTION_HOST_ID)
}

export type PlacementContext = PlacementCaller &
  (
    | {
        operation: 'add' | 'setup'
        selectedPath: string
        kind: 'git' | 'folder'
        /** The caller's own saved-row rule for selections no WSL host can own. */
        claimsOutsideWsl: Exclude<SavedClaimRule, { scope: 'wsl' }>
      }
    | {
        operation: 'create'
        parentPath: string
        name: string
        /** The caller's own duplicate rule for targets that no WSL host can own. */
        sameTarget: (repo: Repo) => boolean
      }
  )

export type WslPlacement = {
  kind: 'wsl'
  environmentId: string
  distro: string
  linuxPath: string
  selectedPath: string
  admission: RepositoryCheckoutAdmission
}

export type ProjectPlacement =
  | { kind: 'saved'; repo: Repo; admission: RepositoryCheckoutAdmission }
  | { kind: 'local'; admission: RepositoryCheckoutAdmission }
  | WslPlacement

export function wslProjectRoutingEnabled(
  store: PlacementStore,
  domain: ExecutionHostId | null
): boolean {
  return (
    process.platform === 'win32' &&
    (domain === null || domain === LOCAL_EXECUTION_HOST_ID) &&
    wslHostsGateOpen() &&
    (getWslHostService()?.isEnabled() ?? store.getSettings?.().experimentalWslHosts === true)
  )
}

/** Called only after saved claims are settled; the paired refusal never starts a distro. */
export async function ensureNewWslOwner(
  store: PlacementStore,
  distro: string,
  caller: PlacementCaller
): Promise<string> {
  if (caller.fromPairedClient) {
    throw new Error('Add this WSL project from the Windows desktop, then open it on its WSL host.')
  }
  const service = getWslHostService()
  if (!service) {
    throw new Error(
      'WSL projects need the desktop app for now. Open Orca on Windows and add this project there.'
    )
  }
  const environmentId = await service.ensure(distro)
  // Why: a gate closed during ensure is not permission to save the project on Windows instead.
  if (!wslProjectRoutingEnabled(store, caller.domain)) {
    throw new Error('WSL projects were turned off while this project was being added.')
  }
  return environmentId
}

/** Decides once which host owns the selection; every mutation consumes this answer. */
export async function placeProject(
  store: PlacementStore,
  context: PlacementContext
): Promise<ProjectPlacement> {
  const target =
    context.operation === 'create' ? join(context.parentPath, context.name) : context.selectedPath
  const wsl = parseWslUncPath(target) !== null && wslProjectRoutingEnabled(store, context.domain)
  if (context.operation === 'create' && !wsl) {
    const { sameTarget } = context
    const findSaved = () => store.getRepos().find(sameTarget)
    const repo = findSaved()
    const admission = { selectedPath: target, registrationPath: target, saved: repo, findSaved }
    return repo ? { kind: 'saved', repo, admission } : { kind: 'local', admission }
  }
  // Why folder for Create: a prospective folder must not be swallowed by a parent checkout.
  const admission = await admitRepositoryCheckout(
    store,
    target,
    context.operation === 'create' ? 'folder' : context.kind,
    wsl || context.operation === 'create'
      ? { scope: 'wsl', domain: context.domain }
      : context.claimsOutsideWsl
  )
  const { saved } = admission
  if (saved) {
    return { kind: 'saved', repo: saved, admission }
  }
  const owner = wsl ? parseWslUncPath(admission.registrationPath) : null
  if (!owner) {
    return { kind: 'local', admission }
  }
  const environmentId = await ensureNewWslOwner(store, owner.distro, context)
  const late = admission.findSaved()
  if (late) {
    return { kind: 'saved', repo: late, admission }
  }
  return {
    kind: 'wsl',
    environmentId,
    distro: owner.distro,
    linuxPath: owner.linuxPath,
    selectedPath: target,
    admission
  }
}
