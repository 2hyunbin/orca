import {
  expect,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@stablyai/playwright-test'
import {
  DOCKER_SSH_HOST_REMOTE_REPO_PATH,
  execDockerSshHostTargetCommand,
  type DockerSshHostTarget
} from './docker-ssh-host-target'
import { openSidebarProjectDialog } from './sidebar-project-dialog'
import { browseManagedProject, returnToProviderSettings } from './plugin-provider-project-browser'
import { capturePluginEvidence } from './plugin-evidence'

export async function qualifyProviderManagedGit(input: {
  page: Page
  app: ElectronApplication
  testInfo: TestInfo
  target: DockerSshHostTarget
}): Promise<void> {
  await input.page.getByRole('button', { name: 'Back to app', exact: true }).click()
  await openSidebarProjectDialog(input.page)
  const dialog = input.page.getByRole('dialog')
  await dialog.getByRole('combobox').click()
  await input.page
    .getByRole('option', { name: /Existing development machine.*Company Node host/u })
    .click()
  await browseManagedProject(input.page, DOCKER_SSH_HOST_REMOTE_REPO_PATH, 'README.md')
  await dialog.getByRole('button', { name: 'Add Git Project', exact: true }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  await input.page.keyboard.press('Escape')
  const project = input.page.getByText('orca-docker-relay-perf-repo', { exact: true }).first()
  await expect(project).toBeVisible()
  await project.hover()
  await input.page
    .getByRole('button', {
      name: 'Create new worktree for orca-docker-relay-perf-repo',
      exact: true
    })
    .click()
  const composer = input.page.getByRole('dialog')
  await composer.getByRole('textbox').first().fill('provider-git-proof')
  await composer.locator('[data-agent-combobox-root="true"][role="combobox"]').click()
  await input.page.getByRole('option', { name: 'Blank Terminal', exact: true }).click()
  await composer.getByRole('button', { name: /^Create (workspace|worktree)$/u }).click()
  await expect(composer).toBeHidden({ timeout: 60_000 })
  const terminal = input.page.locator('.xterm-helper-textarea:visible').first()
  await expect(terminal).toBeVisible()
  await terminal.focus()
  await input.page.keyboard.type(
    "git symbolic-ref --short HEAD; printf 'managed-child-git' > /tmp/orca-provider-workspace/git-proof.txt"
  )
  await input.page.keyboard.press('Enter')
  await expect
    .poll(() =>
      execDockerSshHostTargetCommand(
        input.target,
        'cat /tmp/orca-provider-workspace/git-proof.txt 2>/dev/null || true'
      )
    )
    .toBe('managed-child-git')
  expect(
    execDockerSshHostTargetCommand(
      input.target,
      'git -C /tmp/orca-docker-relay-perf-repo branch --list provider-git-proof'
    )
  ).toContain('provider-git-proof')
  await capturePluginEvidence(
    input.page,
    input.testInfo,
    'node-provider-git-workspace-native',
    input.app
  )
  await input.page.getByRole('button', { name: /^Explorer\b/u }).click()
  await input.page
    .locator('[data-file-explorer-row]')
    .filter({
      has: input.page.getByText('README.md', { exact: true })
    })
    .dblclick({ position: { x: 200, y: 12 } })
  await expect(
    input.page.getByText(
      `remote relay ${input.target.containerName}:${DOCKER_SSH_HOST_REMOTE_REPO_PATH}`,
      { exact: true }
    )
  ).toBeVisible()
  await capturePluginEvidence(
    input.page,
    input.testInfo,
    'node-provider-git-file-native',
    input.app
  )
  await input.page.locator('[data-tab-id][data-tab-title]:visible').first().click()
  await terminal.focus()
  await input.page.keyboard.type('exit')
  await input.page.keyboard.press('Enter')
  await returnToProviderSettings(input.page)
}
