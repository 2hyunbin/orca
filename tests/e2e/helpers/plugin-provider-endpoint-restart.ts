import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  expect,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@stablyai/playwright-test'
import type { SshEditableTarget } from '../../../src/shared/ssh-target-management'
import type { SshConnectionState } from '../../../src/shared/ssh-types'
import type { OrcadManagedRuntimeStatus } from '../../../src/shared/orcad-managed-runtime'
import { decodePairingOffer } from '../../../src/shared/pairing'
import { pairedRuntimeConnectionFromOffer } from '../../../src/shared/paired-runtime-connection'
import { RemoteRuntimeRequestConnection } from '../../../src/shared/remote-runtime-request-connection'
import { unwrapRuntimeRpcResult } from '../../../src/shared/runtime-rpc-result'
import type { HeadlessOracleHost } from './headless-layout-oracle-hosts'
import { capturePluginEvidence } from './plugin-evidence'

export async function qualifyProviderEndpointRestart(input: {
  page: Page
  app: ElectronApplication
  testInfo: TestInfo
  host: HeadlessOracleHost
  hostClient: RemoteRuntimeRequestConnection
  hostEnvironmentId: string
  fixtureRoot: string
  target: SshEditableTarget
  managedEnvironmentId: string
}): Promise<void> {
  const receipts = join(input.fixtureRoot, 'provider-executed.receipts.json')
  const beforeMutations = await readFile(receipts, 'utf8')
  input.hostClient.close()
  await input.host.restart({ abrupt: true, cold: true })
  const client = new RemoteRuntimeRequestConnection(
    pairedRuntimeConnectionFromOffer(decodePairingOffer(input.host.pairingUrl))
  )
  try {
    const targets = unwrapRuntimeRpcResult(
      await client.request<{ targets: SshEditableTarget[] }>(
        'ssh.listEditableTargets',
        undefined,
        15_000
      )
    ).targets
    expect(targets.find((target) => target.id === input.target.id)).toMatchObject({
      id: input.target.id,
      port: input.target.port,
      generation: input.target.generation,
      identityFile: input.target.identityFile
    })
    expect(await readFile(receipts, 'utf8')).toBe(beforeMutations)
    const connected = unwrapRuntimeRpcResult(
      await client.request<{ state: SshConnectionState }>(
        'ssh.connect',
        { targetId: input.target.id },
        120_000
      )
    ).state
    expect(connected.status).toBe('connected')
    expect(connected.managedServer).toMatchObject({
      kind: 'managed',
      environmentId: input.managedEnvironmentId
    })
    const census = unwrapRuntimeRpcResult(
      await client.request<OrcadManagedRuntimeStatus>(
        'managedServer.status',
        { selector: input.managedEnvironmentId },
        60_000
      )
    )
    expect(census.environmentId).toBe(input.managedEnvironmentId)
    expect(census.terminals.liveSessions).toBe(0)
    await input.page.evaluate(async (selector) => {
      const result = await window.api.runtimeEnvironments.connect({ selector })
      if (!result.ok) {
        throw new Error('Could not reconnect the desktop to its restarted Node host')
      }
    }, input.hostEnvironmentId)
    const provider = input.page.locator(
      '[data-environment-provider-id="stablyai.orca-environments-devpods/devpods"]'
    )
    const reopen = input.page.getByRole('button', { name: 'Reopen review', exact: true })
    await expect
      .poll(async () => {
        if (await reopen.isVisible()) {
          return 'reopen'
        }
        if (await provider.isVisible()) {
          return 'provider'
        }
        return 'pending'
      })
      .not.toBe('pending')
    if (await reopen.isVisible()) {
      await reopen.click()
    }
    await expect(provider).toBeVisible()
    await expect(provider.locator('[data-environment-resource-id="devbox"]')).toBeVisible()
    expect(await readFile(receipts, 'utf8')).toBe(beforeMutations)
    expect(await input.page.evaluate(() => window.api.ssh.listTargets())).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: input.target.id })])
    )
    await capturePluginEvidence(
      input.page,
      input.testInfo,
      'node-provider-endpoint-restarted-native',
      input.app
    )
  } finally {
    client.close()
  }
}
