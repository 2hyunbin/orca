import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { runWithOrcadFence, type OrcadFence } from './activation/orcad-activation-fence-scope'
import {
  captureOrcadStateSnapshotCommand,
  clearOrcadStateSnapshotMembersCommand,
  compareOrcadStateSnapshotCommand,
  newestStateMtimeCommand,
  probeOrcadStateSnapshotCommand,
  restoreOrcadStateSnapshotCommand,
  serializedStateMutationCommand
} from './host-state/orcad-state-snapshot'
import { posixProcessGroupCommand } from './host-state/orcad-state-mutation-owner-record'
import { orcadMachineClaimCommand } from './host-state/orcad-machine-claim-command'
import { orcadMachineHomeProbeCommand } from './host-state/orcad-machine-home'
import {
  orcadNodeSlotRuntimeCommand,
  selectOrcadSlotEntryCommand,
  selectOrcadSlotRuntimeCommand
} from './install/orcad-remote-runtime'
import {
  orcadLaunchCommand,
  orcadLivenessProbeCommand,
  readOrcadReadinessCommand
} from './install/orcad-remote-launch'
import {
  installNodeRuntimeFromHostArchiveCommand,
  probeRemoteNodeRuntimeCommand,
  promoteRemoteNodeRuntimeCommand,
  recheckAndPromoteRemoteNodeRuntimeCommand,
  remoteNodeRuntimePresentCommand,
  remoteSha256Command
} from './install/orcad-remote-node-runtime'
import { remoteOrcadBuildHashCommand } from './install/orcad-remote-build-hash'
import { sweepStaleRuntimeStagesCommand } from './install/remote-node-runtime-store-gc'
import { orcadProfilePreflightCommand } from './install/orcad-remote-preflight'
import {
  recordedNodeRuntimeProbeCommand,
  recordedRemoteNodeRuntimeProbeCommand
} from './install/orcad-remote-node-runtime-recorded-probe'
import { runtimeStoreInventoryCommand } from './install/remote-node-runtime-store-inventory'
import { stopOrcadCommand } from './install/orcad-remote-process-control'
import {
  acquireInstallLockParentCommand,
  lockAgeSecondsCommand,
  orphanInstallLockCommand,
  probeInstallLockExistsCommand,
  tryCreateInstallLockCommand,
  tryStealInstallLockCommand
} from './install/remote-install-lock-commands'
import { orcadLogTailCommand } from './install/orcad-remote-log-tail'
import {
  orcadReadinessWaitCommand,
  readOrcadReadinessNowCommand
} from './install/orcad-remote-readiness-wait'
import { orcadPosixStdioBridgeCommand } from './lifecycle/orcad-stdio-bridge-script'

// Why 6 KB: gateways cut exec requests near 10 KB (#30491); this keeps raw commands well under
// the 8,000-byte compression threshold so compression stays a safety net, not the norm.
const POSIX_HOST_OP_BYTE_BUDGET = 6 * 1024

// Ops already past the budget, at their measured size. Ceilings may only shrink; each entry
// leaves when its op moves onto the content-addressed host script (round 4 R4-10, decision D-J).
const OVER_BUDGET_CEILINGS: Readonly<Record<string, number>> = {
  captureOrcadStateSnapshotCommand: 12_236,
  restoreOrcadStateSnapshotCommand: 16_352,
  clearOrcadStateSnapshotMembersCommand: 7_318,
  // Install-lock steal stays shell (it runs before a verified Node exists), so it must shrink.
  tryStealInstallLockCommand: 8_045
}

const host = getRemoteHostPlatform('linux-x64')
// Realistic worst case: a long NFS home, a long account name and a held activation fence.
const home = `/net/nfs-home-cluster-03/users/engineering/${'a'.repeat(48)}.longname`
const baseDir = `${home}/.orca-remote`
const slotDir = `${baseDir}/orcad-1.4.299-rc.12+${'f'.repeat(40)}`
const userDataDir = `${baseDir}/orcad-data`
const snapshotDir = `${baseDir}/orcad-snapshots/pre-1.4.299-rc.12-1760000000000`
const nodePath = `${baseDir}/node-runtimes/v22.20.0-linux-x64-glibc/bin/node`
const token = 'f'.repeat(64)
const fence: OrcadFence = { lockDir: `${baseDir}/orcad-activation.lock`, token }
const owner = { fileName: 'owner', token }
const target = 'linux-x64-glibc' as const

const BUILDERS: Readonly<Record<string, () => string>> = {
  serializedStateMutationCommand: () => serializedStateMutationCommand(baseDir, ':', 20, fence),
  captureOrcadStateSnapshotCommand: () =>
    captureOrcadStateSnapshotCommand(host, userDataDir, snapshotDir, baseDir),
  probeOrcadStateSnapshotCommand: () => probeOrcadStateSnapshotCommand(host, snapshotDir, baseDir),
  restoreOrcadStateSnapshotCommand: () =>
    restoreOrcadStateSnapshotCommand(host, userDataDir, snapshotDir, baseDir),
  clearOrcadStateSnapshotMembersCommand: () =>
    clearOrcadStateSnapshotMembersCommand(host, userDataDir, baseDir),
  compareOrcadStateSnapshotCommand: () =>
    compareOrcadStateSnapshotCommand(host, userDataDir, snapshotDir, baseDir),
  newestStateMtimeCommand: () => newestStateMtimeCommand(host, userDataDir, baseDir),
  posixProcessGroupCommand: () => posixProcessGroupCommand('"$pid"'),
  orcadMachineClaimCommand: () => orcadMachineClaimCommand(host, home, 'k'.repeat(64)),
  orcadMachineHomeProbeCommand: () => orcadMachineHomeProbeCommand(host),
  selectOrcadSlotEntryCommand: () => selectOrcadSlotEntryCommand(host, slotDir),
  orcadNodeSlotRuntimeCommand: () => orcadNodeSlotRuntimeCommand(host, slotDir),
  selectOrcadSlotRuntimeCommand: () => selectOrcadSlotRuntimeCommand(host, slotDir, nodePath),
  orcadLaunchCommand: () =>
    orcadLaunchCommand(
      host,
      {
        remoteInstallDir: slotDir,
        nodePath,
        fullVersion: '1.4.299-rc.12',
        userDataDir,
        bindHost: '127.0.0.1',
        port: 65535,
        activationRoot: `${baseDir}/orcad-activation`
      },
      'setsid',
      [['ORCA_EXAMPLE_HOST_ENV', 'x'.repeat(200)]]
    ),
  readOrcadReadinessCommand: () => readOrcadReadinessCommand(host, slotDir),
  orcadLivenessProbeCommand: () => orcadLivenessProbeCommand(host, slotDir),
  remoteSha256Command: () => remoteSha256Command(`'${nodePath}'`),
  probeRemoteNodeRuntimeCommand: () => probeRemoteNodeRuntimeCommand(host, nodePath, target),
  remoteNodeRuntimePresentCommand: () => remoteNodeRuntimePresentCommand(host, nodePath, true),
  promoteRemoteNodeRuntimeCommand: () => promoteRemoteNodeRuntimeCommand(host, promoteArgs()),
  recheckAndPromoteRemoteNodeRuntimeCommand: () =>
    recheckAndPromoteRemoteNodeRuntimeCommand(host, promoteArgs()),
  installNodeRuntimeFromHostArchiveCommand: () =>
    installNodeRuntimeFromHostArchiveCommand(host, {
      runtimeDir: nodePath,
      archive: `${baseDir}/node-runtimes/archive.tar.xz`,
      target,
      token
    }),
  remoteOrcadBuildHashCommand: () => remoteOrcadBuildHashCommand(host, slotDir),
  sweepStaleRuntimeStagesCommand: () =>
    sweepStaleRuntimeStagesCommand(`${baseDir}/node-runtimes`, host),
  orcadProfilePreflightCommand: () => orcadProfilePreflightCommand(host, slotDir, token),
  recordedNodeRuntimeProbeCommand: () => recordedNodeRuntimeProbeCommand(host, nodePath, token),
  recordedRemoteNodeRuntimeProbeCommand: () =>
    recordedRemoteNodeRuntimeProbeCommand(host, nodePath, target),
  runtimeStoreInventoryCommand: () => runtimeStoreInventoryCommand(host, home),
  stopOrcadCommand: () => stopOrcadCommand(host, slotDir, { waitSeconds: 30, nodePath }),
  acquireInstallLockParentCommand: () => acquireInstallLockParentCommand(host, baseDir),
  tryCreateInstallLockCommand: () =>
    tryCreateInstallLockCommand(host, `${slotDir}.install-lock`, owner),
  probeInstallLockExistsCommand: () =>
    probeInstallLockExistsCommand(host, `${slotDir}.install-lock`),
  lockAgeSecondsCommand: () => lockAgeSecondsCommand(host, `${slotDir}.install-lock`),
  orphanInstallLockCommand: () => orphanInstallLockCommand(host, `${slotDir}.install-lock`),
  tryStealInstallLockCommand: () =>
    tryStealInstallLockCommand(host, `${slotDir}.install-lock`, 120, owner, {
      ...owner,
      quietSeconds: 60,
      mutationLock: `${baseDir}/orcad-state-mutation.lock`
    }),
  orcadLogTailCommand: () => orcadLogTailCommand(host, slotDir),
  orcadReadinessWaitCommand: () => orcadReadinessWaitCommand(host, slotDir, 120),
  readOrcadReadinessNowCommand: () => readOrcadReadinessNowCommand(host, slotDir),
  orcadPosixStdioBridgeCommand: () => orcadPosixStdioBridgeCommand(65535)
}

function promoteArgs(): Parameters<typeof promoteRemoteNodeRuntimeCommand>[1] {
  return {
    stageDir: `${nodePath}.stage-${token}`,
    archive: `${baseDir}/node-runtimes/archive.tar.xz`,
    runtimeDir: nodePath,
    target,
    token
  }
}

// Exported builders that never produce a POSIX host op.
const NOT_POSIX_HOST_OPS = new Set<string>([])

function exportedCommandBuilders(): string[] {
  const names: string[] = []
  for (const dir of ['host-state', 'install', 'lifecycle', 'activation']) {
    const root = join(__dirname, dir)
    for (const file of readdirSync(root)) {
      if (
        !file.endsWith('.ts') ||
        /\.test(-fixture)?\.ts$/.test(file) ||
        file.endsWith('.spec.ts')
      ) {
        continue
      }
      if (/windows/i.test(file)) {
        continue
      }
      const source = readFileSync(join(root, file), 'utf8')
      for (const match of source.matchAll(/^export (?:async )?function (\w+Command)\(/gm)) {
        names.push(match[1])
      }
    }
  }
  return names.sort()
}

describe('POSIX host-op byte budget', () => {
  it('measures every exported POSIX host-op builder', () => {
    const unmeasured = exportedCommandBuilders().filter(
      (name) => !(name in BUILDERS) && !NOT_POSIX_HOST_OPS.has(name)
    )
    expect(unmeasured).toEqual([])
  })

  it.each(Object.keys(BUILDERS))('%s stays under the raw byte budget', async (name) => {
    const command = await runWithOrcadFence(fence, async () => BUILDERS[name]())
    const bytes = Buffer.byteLength(command, 'utf8')
    const ceiling = OVER_BUDGET_CEILINGS[name]
    if (ceiling === undefined) {
      expect(bytes).toBeLessThanOrEqual(POSIX_HOST_OP_BYTE_BUDGET)
      return
    }
    // A listed op must stay listed only while it is actually over budget.
    expect(bytes).toBeGreaterThan(POSIX_HOST_OP_BYTE_BUDGET)
    expect(bytes).toBeLessThanOrEqual(ceiling)
  })
})
