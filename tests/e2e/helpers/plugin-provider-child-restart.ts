import { runProcess } from '@orca/process-host'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  expect,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@stablyai/playwright-test'
import type { DockerSshHostTarget } from './docker-ssh-host-target'
import { returnToProviderSettings } from './plugin-provider-project-browser'
import { qualifyProviderWorkspaceReopen } from './plugin-provider-workspace-reopen'
import { capturePluginEvidence } from './plugin-evidence'

export async function qualifyProviderChildRestart(input: {
  page: Page
  app: ElectronApplication
  testInfo: TestInfo
  target: DockerSshHostTarget
  managedEnvironmentId: string
  fixtureRoot: string
}): Promise<{ previousRuntimeId: string; nextRuntimeId: string; savedEnvironmentId: string }> {
  const savedChild = async () =>
    (await input.page.evaluate(() => window.api.runtimeEnvironments.list())).find(
      (environment) =>
        environment.managedGateway?.descriptor.environmentId === input.managedEnvironmentId
    )
  const before = await savedChild()
  const descriptor = before?.managedGateway?.descriptor
  if (!before || !descriptor?.childHostKeyFingerprint || !before.runtimeId) {
    throw new Error('The saved child has no verified managed identity')
  }
  const receipts = join(input.fixtureRoot, 'provider-executed.receipts.json')
  const mutations = await readFile(receipts, 'utf8')
  const stop = await runProcess({
    program: 'docker',
    args: ['stop', '--time', '1', input.target.containerName],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 30_000
  })
  expect(stop.code).toBe(0)
  await expect
    .poll(
      async () => {
        const snapshots = await input.page.evaluate(() =>
          window.api.runtimeEnvironments.getStatusSnapshots()
        )
        return snapshots.find((snapshot) => snapshot.environmentId === before.id)?.verification
      },
      { timeout: 30_000 }
    )
    .not.toBe('verified')
  expect((await savedChild())?.id).toBe(before.id)
  await capturePluginEvidence(
    input.page,
    input.testInfo,
    'node-provider-child-unavailable-native',
    input.app
  )
  const start = await runProcess({
    program: 'docker',
    args: ['start', input.target.containerName],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 30_000
  })
  expect(start.code).toBe(0)
  await returnToProviderSettings(input.page)
  await qualifyProviderWorkspaceReopen({
    ...input,
    captureName: 'node-provider-child-restarted-workspace-native'
  })
  const after = await savedChild()
  expect(after?.id).toBe(before.id)
  expect(after?.runtimeId).toBeTruthy()
  expect(after?.runtimeId).not.toBe(before.runtimeId)
  expect(after?.managedGateway?.descriptor).toMatchObject({
    childHostKeyFingerprint: descriptor.childHostKeyFingerprint,
    environmentId: descriptor.environmentId,
    sshTargetId: descriptor.sshTargetId,
    targetGeneration: descriptor.targetGeneration
  })
  expect(await readFile(receipts, 'utf8')).toBe(mutations)
  if (!after?.runtimeId) {
    throw new Error('The restarted child has no verified runtime identity')
  }
  return {
    previousRuntimeId: before.runtimeId,
    nextRuntimeId: after.runtimeId,
    savedEnvironmentId: before.id
  }
}
