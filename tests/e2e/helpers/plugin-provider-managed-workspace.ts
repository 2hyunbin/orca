import {
  expect,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@stablyai/playwright-test'
import { execDockerSshHostTargetCommand, type DockerSshHostTarget } from './docker-ssh-host-target'
import { capturePluginEvidence } from './plugin-evidence'
import { browseManagedProject, returnToProviderSettings } from './plugin-provider-project-browser'

export async function qualifyProviderManagedWorkspace(input: {
  page: Page
  app: ElectronApplication
  testInfo: TestInfo
  target: DockerSshHostTarget
}): Promise<void> {
  execDockerSshHostTargetCommand(
    input.target,
    "mkdir -p /tmp/orca-provider-workspace && printf 'This file belongs to the managed Linux child.\\n' > /tmp/orca-provider-workspace/child-proof.txt"
  )
  const machine = input.page.locator('[data-environment-resource-id="devbox"]')
  await machine.getByRole('button', { name: 'Open workspace', exact: true }).click()
  const dialog = input.page.getByRole('dialog')
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  await capturePluginEvidence(
    input.page,
    input.testInfo,
    'node-provider-workspace-selected-native',
    input.app
  )
  await browseManagedProject(input.page, '/tmp/orca-provider-workspace', 'child-proof.txt')
  await dialog.getByRole('button', { name: 'Open as Folder', exact: true }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  await input.page.keyboard.press('Escape')
  await expect(
    input.page.getByText('orca-provider-workspace', { exact: true }).first()
  ).toBeVisible()
  await input.page.getByText('orca-provider-workspace', { exact: true }).first().hover()
  await input.page
    .getByRole('button', {
      name: 'Create workspace for orca-provider-workspace',
      exact: true
    })
    .click()
  const composer = input.page.getByRole('dialog')
  await expect(composer).toBeVisible()
  await composer
    .getByPlaceholder('Workspace name', { exact: true })
    .fill('Provider folder workspace')
  await capturePluginEvidence(
    input.page,
    input.testInfo,
    'node-provider-folder-composer-native',
    input.app
  )
  await composer.locator('[data-agent-combobox-root="true"][role="combobox"]').click()
  await input.page.getByRole('option', { name: 'Blank Terminal', exact: true }).click()
  await composer.getByRole('button', { name: 'Create workspace', exact: true }).click()
  await expect(composer).toBeHidden({ timeout: 30_000 })
  const terminalInput = input.page.locator('.xterm-helper-textarea').first()
  await terminalInput.focus()
  await input.page.keyboard.type(
    "printf 'ORCA_CHILD_PROOF:%s\\n' \"$(hostname)\"; uname -s; printf 'managed-child-terminal' > /tmp/orca-provider-workspace/terminal-proof.txt"
  )
  await input.page.keyboard.press('Enter')
  await expect
    .poll(() =>
      execDockerSshHostTargetCommand(
        input.target,
        'cat /tmp/orca-provider-workspace/terminal-proof.txt 2>/dev/null || true'
      )
    )
    .toBe('managed-child-terminal')
  await capturePluginEvidence(
    input.page,
    input.testInfo,
    'node-provider-child-terminal-native',
    input.app
  )
  await capturePluginEvidence(
    input.page,
    input.testInfo,
    'node-provider-folder-workspace-native',
    input.app
  )
  await input.page.getByRole('button', { name: /^Explorer\b/u }).click()
  await input.page
    .locator('[data-file-explorer-row]')
    .filter({
      has: input.page.getByText('child-proof.txt', { exact: true })
    })
    .dblclick({ position: { x: 200, y: 12 } })
  await expect(input.page.locator('.monaco-editor .view-lines')).toContainText(
    'This file belongs to the managed Linux child.'
  )
  const modifier = await input.page.evaluate(() =>
    navigator.userAgent.includes('Mac') ? 'Meta' : 'Control'
  )
  await input.page.locator('.monaco-editor .view-lines').click()
  await input.page.keyboard.press(`${modifier}+End`)
  await input.page.keyboard.type('\nEdited through the control host.')
  await input.page.keyboard.press(`${modifier}+s`)
  await expect
    .poll(() =>
      execDockerSshHostTargetCommand(
        input.target,
        'cat /tmp/orca-provider-workspace/child-proof.txt'
      )
    )
    .toContain('Edited through the control host.')
  await capturePluginEvidence(
    input.page,
    input.testInfo,
    'node-provider-child-file-native',
    input.app
  )
  await input.page.locator('[data-tab-id][data-tab-title]').first().click()
  await terminalInput.focus()
  await input.page.keyboard.type('exit')
  await input.page.keyboard.press('Enter')
  expect(await input.page.evaluate(() => Boolean(window.__store))).toBe(false)
  await returnToProviderSettings(input.page)
}
