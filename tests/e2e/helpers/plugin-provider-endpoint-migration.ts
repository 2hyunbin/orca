import { createConnection, createServer, type Socket } from 'node:net'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  expect,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@stablyai/playwright-test'
import { environmentRecipeResourceSchema } from '../../../src/shared/environment-recipe-protocol'
import type { SshConnectionState } from '../../../src/shared/ssh-types'
import type { SshEditableTarget } from '../../../src/shared/ssh-target-management'
import type { OrcadManagedRuntimeStatus } from '../../../src/shared/orcad-managed-runtime'
import type { RemoteRuntimeRequestConnection } from '../../../src/shared/remote-runtime-request-connection'
import { unwrapRuntimeRpcResult } from '../../../src/shared/runtime-rpc-result'
import { capturePluginEvidence } from './plugin-evidence'

export async function qualifyProviderEndpointMigration(input: {
  page: Page
  app: ElectronApplication
  testInfo: TestInfo
  fixtureRoot: string
  saved: SshEditableTarget
  hostClient: RemoteRuntimeRequestConnection
  managedEnvironmentId: string
}): Promise<{ targetId: string; previousGeneration: number; nextGeneration: number }> {
  const { page, app, testInfo, saved, hostClient } = input
  const sockets = new Set<Socket>()
  let accepted = 0
  const endpoint = createServer((socket) => {
    accepted += 1
    const upstream = createConnection({ host: saved.host, port: saved.port })
    for (const connection of [socket, upstream]) {
      sockets.add(connection)
      connection.once('close', () => sockets.delete(connection))
      connection.on('error', () => {
        socket.destroy()
        upstream.destroy()
      })
    }
    socket.pipe(upstream).pipe(socket)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      endpoint.once('error', reject)
      endpoint.listen(0, '127.0.0.1', resolve)
    })
    const address = endpoint.address()
    if (!address || typeof address === 'string') {
      throw new Error('The owned migration endpoint did not bind')
    }
    const inventoryFile = join(input.fixtureRoot, 'provider-executed.inventory.json')
    const inventory: unknown = JSON.parse(await readFile(inventoryFile, 'utf8'))
    if (!inventory || typeof inventory !== 'object' || !('devbox' in inventory)) {
      throw new Error('The provider inventory has no devbox')
    }
    const previous = environmentRecipeResourceSchema.parse(inventory.devbox)
    if (!previous.connection || !saved.generation) {
      throw new Error('The connected devbox has no versioned endpoint')
    }
    const next = {
      ...previous,
      revision: 'endpoint-migration-r2',
      connection: { ...previous.connection, host: '127.0.0.1', port: address.port }
    }
    await writeFile(inventoryFile, JSON.stringify({ devbox: next }))
    const provider = page.locator(
      '[data-environment-provider-id="stablyai.orca-environments-devpods/devpods"]'
    )
    const machine = provider.locator('[data-environment-resource-id="devbox"]')
    const readTargets = async (): Promise<SshEditableTarget[]> =>
      unwrapRuntimeRpcResult(
        await hostClient.request<{ targets: SshEditableTarget[] }>(
          'ssh.listEditableTargets',
          undefined,
          15_000
        )
      ).targets
    const state = async (): Promise<SshConnectionState> =>
      unwrapRuntimeRpcResult(
        await hostClient.request<{ state: SshConnectionState }>(
          'ssh.getState',
          { targetId: saved.id },
          15_000
        )
      ).state
    await provider.getByRole('button', { name: 'Refresh inventory', exact: true }).click()
    await expect.poll(async () => (await state())?.status ?? 'disconnected').toBe('disconnected')
    await machine.getByRole('button', { name: 'Connect', exact: true }).click()
    const review = page.getByRole('dialog', {
      name: 'Update saved environment connection',
      exact: true
    })
    await expect(review).toContainText(`root@${saved.host}:${saved.port}`)
    await expect(review).toContainText(`root@127.0.0.1:${address.port}`)
    await expect(review.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    expect(accepted).toBe(0)
    await capturePluginEvidence(page, testInfo, 'node-provider-endpoint-review-native', app)
    await review.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(review).toBeHidden()
    expect((await readTargets()).find((target) => target.id === saved.id)).toMatchObject({
      port: saved.port,
      generation: saved.generation
    })
    expect(accepted).toBe(0)
    await machine.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(review).toBeVisible()
    await review.getByRole('button', { name: 'Update & connect', exact: true }).click()
    await expect(review).toBeHidden()
    const updated = (await readTargets()).find((target) => target.id === saved.id)
    await writeFile(
      testInfo.outputPath('endpoint-save-diagnostic.json'),
      JSON.stringify(
        {
          updated,
          accepted,
          state: await state(),
          alerts: await provider.getByRole('alert').allTextContents()
        },
        null,
        2
      )
    )
    await capturePluginEvidence(page, testInfo, 'node-provider-endpoint-after-save-native', app)
    expect(updated).toMatchObject({ port: address.port })
    try {
      await expect.poll(async () => (await state())?.status, { timeout: 90_000 }).toBe('connected')
    } catch (error) {
      await writeFile(
        testInfo.outputPath('endpoint-migration-diagnostic.json'),
        JSON.stringify(
          {
            updated,
            accepted,
            state: await state(),
            alerts: await provider.getByRole('alert').allTextContents()
          },
          null,
          2
        )
      )
      await capturePluginEvidence(page, testInfo, 'node-provider-endpoint-failed-native', app)
      throw error
    }
    await expect
      .poll(async () => (await state()).managedServer)
      .toMatchObject({
        kind: 'managed',
        environmentId: input.managedEnvironmentId
      })
    if (!updated?.generation) {
      throw new Error('The updated provider target has no generation')
    }
    expect(updated.port).toBe(address.port)
    expect(updated.generation).toBeGreaterThan(saved.generation)
    expect(updated.identityFile).toBe(saved.identityFile)
    expect(accepted).toBeGreaterThan(0)
    const census = unwrapRuntimeRpcResult(
      await hostClient.request<OrcadManagedRuntimeStatus>(
        'managedServer.status',
        { selector: input.managedEnvironmentId },
        60_000
      )
    )
    expect(census.environmentId).toBe(input.managedEnvironmentId)
    expect(census.terminals.liveSessions).toBe(0)
    await capturePluginEvidence(page, testInfo, 'node-provider-endpoint-connected-native', app)
    return {
      targetId: updated.id,
      previousGeneration: saved.generation,
      nextGeneration: updated.generation
    }
  } finally {
    for (const socket of sockets) {
      socket.destroy()
    }
    await new Promise<void>((resolve) => endpoint.close(() => resolve()))
  }
}
