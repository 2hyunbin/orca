import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@stablyai/playwright-test'
import { z } from 'zod'
import { decodePairingOffer } from '../../src/shared/pairing'
import { pairedRuntimeConnectionFromOffer } from '../../src/shared/paired-runtime-connection'
import { RemoteRuntimeRequestConnection } from '../../src/shared/remote-runtime-request-connection'
import { unwrapRuntimeRpcResult } from '../../src/shared/runtime-rpc-result'
import type {
  SshEditableTargetAddResult,
  SshEditableTarget
} from '../../src/shared/ssh-target-management'
import {
  MIN_SSH_RELAY_GRACE_PERIOD_SECONDS,
  type SshConnectionState
} from '../../src/shared/ssh-types'
import type { RuntimeStatus } from '../../src/shared/runtime-types'
import type { OrcadManagedRuntimeStatus } from '../../src/shared/orcad-managed-runtime'
import { NODE_RUNTIME_PIN } from '../../src/shared/node-runtime-pin'
import { quotePosixShell } from '../../src/shared/wsl-login-shell-command'
import { ORCAD_VERSION_FILENAME } from '../../src/shared/orcad-artifacts'
import { startHeadlessOracleHost } from './helpers/headless-layout-oracle-hosts'
import { ensureDockerSshHostImage } from './helpers/docker-ssh-host-image'
import { startOrcadConvertHost } from './helpers/orcad-convert-host'

const RemoteStartup = z.object({
  health: z.object({
    platform: z.literal('linux'),
    nodeVersion: z.literal(NODE_RUNTIME_PIN.version),
    buildVersion: z.string(),
    terminalDaemon: z.object({
      state: z.literal('live'),
      ownsFreshSessions: z.literal(true),
      buildVersion: z.string(),
      selfTest: z.object({ ok: z.literal(true), coverage: z.literal('pty-spawn') })
    }),
    profileStateAuthority: z.object({ backend: z.literal('sqlite') })
  })
})

test.skip(process.env.ORCA_E2E_SSH_DOCKER !== '1', 'Needs the managed SSH Docker lane')

test('a packaged Node control host deploys a fresh SSH server and retains it after restart', async ({
  browserName: _browserName
}, testInfo) => {
  test.setTimeout(300_000)
  ensureDockerSshHostImage(process.cwd())
  const remote = startOrcadConvertHost('docker', testInfo)
  let host: Awaited<ReturnType<typeof startHeadlessOracleHost>> | undefined
  let client: RemoteRuntimeRequestConnection | undefined
  try {
    if (!remote.exec) {
      throw new Error('Owned Docker controls are unavailable')
    }
    host = await startHeadlessOracleHost('orcad', { grantDesktopControl: true })
    const pair = (): RemoteRuntimeRequestConnection => {
      if (!host) {
        throw new Error('Owned Node host is unavailable')
      }
      return new RemoteRuntimeRequestConnection(
        pairedRuntimeConnectionFromOffer(decodePairingOffer(host.pairingUrl))
      )
    }
    client = pair()
    const status = unwrapRuntimeRpcResult(
      await client.request<RuntimeStatus>('status.get', undefined, 15_000)
    )
    expect(status.capabilities).toEqual(
      expect.arrayContaining([
        'ssh.target-management.v1',
        'plugins.environments.ssh.v1',
        'managedServer.v1'
      ])
    )
    const added = unwrapRuntimeRpcResult(
      await client.request<SshEditableTargetAddResult>(
        'ssh.addTarget',
        {
          target: { ...remote.input, relayGracePeriodSeconds: MIN_SSH_RELAY_GRACE_PERIOD_SECONDS }
        },
        15_000
      )
    )
    const connected = unwrapRuntimeRpcResult(
      await client.request<{ state: SshConnectionState }>(
        'ssh.connect',
        { targetId: added.target.id },
        240_000
      )
    )
    expect(connected.state.status).toBe('connected')
    const managed = connected.state.managedServer
    if (managed?.kind !== 'managed') {
      throw new Error('The fresh host was not deployed as a managed server')
    }
    const inspect = async (): Promise<OrcadManagedRuntimeStatus> => {
      if (!client) {
        throw new Error('Owned paired client is unavailable')
      }
      return unwrapRuntimeRpcResult(
        await client.request<OrcadManagedRuntimeStatus>(
          'managedServer.status',
          { selector: managed.environmentId },
          60_000
        )
      )
    }
    const before = await inspect()
    expect(before.environmentId).toBe(managed.environmentId)
    expect(before.terminals.liveSessions).toBe(0)
    expect(before.terminals.startedSinceActivation).toBe(0)
    if (!before.activeVersion) {
      throw new Error('The fresh server has no active version')
    }
    const remoteStartupPath = `/root/.orca-remote/orcad-${before.activeVersion}/.orcad-readiness`
    const startupBytes = remote.exec(`cat ${quotePosixShell(remoteStartupPath)}`)
    const startup = RemoteStartup.parse(
      JSON.parse(startupBytes.split('\n').find((line) => line.startsWith('{')) ?? 'null')
    )
    expect(startup.health.buildVersion).toBe(before.activeVersion)
    expect(startup.health.terminalDaemon.buildVersion).toBe(before.activeVersion)
    client.close()
    client = undefined
    await host.restart({ cold: true })
    client = pair()
    const targets = unwrapRuntimeRpcResult(
      await client.request<{ targets: SshEditableTarget[] }>(
        'ssh.listEditableTargets',
        undefined,
        15_000
      )
    )
    const saved = targets.targets.find((target) => target.id === added.target.id)
    expect(saved?.generation).toBe(added.target.generation)
    const reconnected = unwrapRuntimeRpcResult(
      await client.request<{ state: SshConnectionState }>(
        'ssh.connect',
        { targetId: added.target.id },
        60_000
      )
    )
    expect(reconnected.state.managedServer).toMatchObject({
      kind: 'managed',
      environmentId: managed.environmentId
    })
    const after = await inspect()
    expect(after.activeVersion).toBe(before.activeVersion)
    expect(after.terminals.liveSessions).toBe(0)
    const installedVersion = readFileSync(
      join(process.cwd(), 'out/orcad', ORCAD_VERSION_FILENAME),
      'utf8'
    ).trim()
    const receiptPath = testInfo.outputPath('owned-node-control-host-ssh.json')
    await writeFile(
      receiptPath,
      JSON.stringify(
        {
          scope: 'Actual packaged control host to owned Linux SSH container; no renderer',
          installedVersion,
          targetGeneration: saved?.generation,
          before,
          after,
          remoteStartupHealth: startup.health
        },
        null,
        2
      )
    )
    await testInfo.attach('owned-node-control-host-ssh', {
      path: receiptPath,
      contentType: 'application/json'
    })
  } finally {
    client?.close()
    try {
      await host?.dispose()
    } finally {
      remote.cleanup()
    }
  }
})
