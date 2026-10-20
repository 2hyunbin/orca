import { createHash } from 'node:crypto'
import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
import { classifyRuntimeEnvironmentHost } from '../../shared/runtime-environment-host-kind'
import {
  getOrcadSshDeployment,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { MAX_RUNTIME_ENVIRONMENT_PREVIOUS_PAIRINGS } from '../../shared/runtime-environment-pairing-history'
import { wslHostRegistration } from '../../shared/wsl-host-deployment-link'

export type PairedRuntimeBrowserAuthorityIdentities = {
  /** Storage identity of the connection to the paired server; names its partitions. */
  authorityConnectionIdentity: string
  /**
   * Other identity schemes for this same server, most recent first, paired with the current
   * execution-host identity. A partition one of them owns is adopted instead of starting empty.
   */
  adoptableAuthorityConnectionIdentities: readonly string[]
  /**
   * Superseded per-process identity, paired with the legacy execution-host identity; null when
   * its partition must not be adopted.
   */
  legacyAuthorityConnectionIdentity: string | null
}

export type PairedRuntimeBrowserAuthorityIdentityInput = {
  orcaProfileId: string
  environment: KnownRuntimeEnvironment
  connection: PairedRuntimeConnection
  authorityRuntimeId: string
}

type PairingRecord = {
  pairingRevision: number
  pairedDeviceId?: string
  wslDistroId?: string
}

/**
 * Storage identities of the connection to a paired server.
 *
 * Managed SSH and WSL hosts re-pair whenever Orca updates, rolls back, recovers, or relaunches
 * their orcad, which bumps the pairing revision and mints a new device. Their identity therefore
 * names only what survives a re-pair -- the environment record, the server's key, and (WSL) the
 * distro registration -- so the user's logins survive it too. Every other server keeps the
 * revision-scoped identity: its pairing changes only when the user re-pairs it.
 */
export function derivePairedRuntimeBrowserAuthorityIdentities(
  input: PairedRuntimeBrowserAuthorityIdentityInput
): PairedRuntimeBrowserAuthorityIdentities {
  const { orcaProfileId, environment, connection } = input
  const current: PairingRecord = {
    pairingRevision: environment.pairingRevision ?? environment.createdAt,
    pairedDeviceId: connection.pairedDeviceId,
    wslDistroId: environment.pairingWslDistroId
  }
  const revisionScopedOf = (pairing: PairingRecord): string =>
    revisionScopedAuthorityConnectionIdentity(orcaProfileId, environment.id, {
      pairingRevision: pairing.pairingRevision,
      hostPublicKeyB64: connection.hostPublicKeyB64,
      pairedDeviceId: pairing.pairedDeviceId
    })
  const revisionScopedFor = (pairings: readonly PairingRecord[]): string[] =>
    pairings.map(revisionScopedOf)
  const revisionScoped = revisionScopedOf(current)
  // Why: re-pairs before the first page opened on this build still own the user's jar. The
  // current key keeps it to this host: a re-pair that changed keys derives an unbound identity.
  const pairingHistory: readonly PairingRecord[] = [
    current,
    ...(environment.previousPairings ?? []).slice(0, MAX_RUNTIME_ENVIRONMENT_PREVIOUS_PAIRINGS)
  ]
  const legacyAuthorityConnectionIdentity = runtimeScopedAuthorityConnectionIdentity(
    orcaProfileId,
    environment.id,
    current.pairingRevision,
    input.authorityRuntimeId,
    connection
  )
  const host = classifyRuntimeEnvironmentHost(environment)
  switch (host.kind) {
    case 'wsl': {
      const registration = wslHostRegistration(host.deployment)
      const distroId = registration.current
      // Why: without the registration GUID a re-imported distro is indistinguishable, so fail
      // closed to the revision-scoped identity rather than risk sharing a partition across hosts.
      if (!distroId) {
        return {
          authorityConnectionIdentity: revisionScoped,
          adoptableAuthorityConnectionIdentities: [],
          legacyAuthorityConnectionIdentity
        }
      }
      // Why: a re-imported distro can keep the server key, so only a pairing made under this
      // exact registration may hand over its jar -- never one made before the GUID was known.
      const madeUnder = (pairing: PairingRecord): string | undefined =>
        pairing.wslDistroId ?? registration.unrecordedPairing
      const sameRegistration = pairingHistory.filter((pairing) => madeUnder(pairing) === distroId)
      return {
        authorityConnectionIdentity: rePairStableAuthorityConnectionIdentity(
          orcaProfileId,
          environment.id,
          connection,
          ['wsl', distroId]
        ),
        adoptableAuthorityConnectionIdentities: revisionScopedFor(sameRegistration),
        legacyAuthorityConnectionIdentity:
          madeUnder(current) === distroId ? legacyAuthorityConnectionIdentity : null
      }
    }
    case 'network': {
      const managedSsh = rePairStableAuthorityConnectionIdentity(
        orcaProfileId,
        environment.id,
        connection,
        ['managed-ssh']
      )
      if (getOrcadSshDeployment(environment)) {
        return {
          authorityConnectionIdentity: managedSsh,
          adoptableAuthorityConnectionIdentities: revisionScopedFor(pairingHistory),
          legacyAuthorityConnectionIdentity
        }
      }
      // Why adopt managedSsh: a stale sidecar hides the deployment link, and the record must
      // reclaim the partition it already holds instead of colliding with its old name.
      return {
        authorityConnectionIdentity: revisionScoped,
        adoptableAuthorityConnectionIdentities: [managedSsh],
        legacyAuthorityConnectionIdentity
      }
    }
  }
}

/** The identity every paired server used before W1; unchanged bit-for-bit for non-rotating hosts. */
function revisionScopedAuthorityConnectionIdentity(
  orcaProfileId: string,
  environmentId: string,
  pairing: RevisionScopedPairing
): string {
  return connectionIdentityDigest([
    'paired-runtime-browser',
    orcaProfileId,
    environmentId,
    pairing.pairingRevision,
    pairing.hostPublicKeyB64,
    pairing.pairedDeviceId ?? null
  ])
}

type RevisionScopedPairing = {
  pairingRevision: number
  hostPublicKeyB64: string
  pairedDeviceId?: string
}

/** Superseded per-process identity, kept only so its partition can be adopted. */
function runtimeScopedAuthorityConnectionIdentity(
  orcaProfileId: string,
  environmentId: string,
  pairingRevision: number,
  authorityRuntimeId: string,
  connection: PairedRuntimeConnection
): string {
  return connectionIdentityDigest([
    'paired-runtime-browser',
    orcaProfileId,
    environmentId,
    pairingRevision,
    authorityRuntimeId,
    connection.hostPublicKeyB64,
    connection.pairedDeviceId ?? null
  ])
}

function rePairStableAuthorityConnectionIdentity(
  orcaProfileId: string,
  environmentId: string,
  connection: PairedRuntimeConnection,
  hostKind: readonly string[]
): string {
  return connectionIdentityDigest([
    'paired-runtime-browser-re-pair-stable',
    orcaProfileId,
    environmentId,
    connection.hostPublicKeyB64,
    hostKind
  ])
}

function connectionIdentityDigest(components: readonly unknown[]): string {
  return `paired-runtime:${createHash('sha256').update(JSON.stringify(components)).digest('hex')}`
}
