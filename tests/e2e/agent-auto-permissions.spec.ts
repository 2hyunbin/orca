import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.use({ seedTestRepo: false })

test('agent permissions are scoped and persist without a global Auto option', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(() =>
    window.__store.getState().updateSettingsOrThrow({ nativeChatPermissionMode: 'accept-edits' })
  )
  await orcaPage.getByRole('button', { name: 'Settings', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Agents', exact: true }).click()
  const claude = orcaPage.getByRole('button', { name: 'Claude permissions', exact: true })
  const codex = orcaPage.getByRole('button', { name: 'Codex permissions', exact: true })
  await expect(orcaPage.getByRole('radiogroup', { name: 'Agent Permissions' })).toHaveCount(0)
  await expect(orcaPage.getByRole('button', { name: 'OpenClaude permissions' })).toHaveCount(0)

  await orcaPage.getByRole('button', { name: 'Set defaults…', exact: true }).click()
  await expect(orcaPage.getByRole('menuitem', { name: /Auto/ })).toHaveCount(0)
  await orcaPage.getByRole('menuitem', { name: 'Manual defaults', exact: true }).click()
  await expect(claude).toHaveText('Manual')
  await expect(codex).toHaveText('Manual')

  for (const [label, args] of [
    ['Auto', '--approve-for-me'],
    ['Yolo', '--dangerously-bypass-approvals-and-sandbox'],
    ['Manual', ''],
    ['Auto', '--approve-for-me']
  ]) {
    await codex.click()
    await orcaPage.getByRole('menuitemradio', { name: label, exact: true }).click()
    await expect(codex).toHaveText(label)
    await expect(claude).toHaveText('Manual')
    await expect
      .poll(() =>
        orcaPage.evaluate(async () => {
          const settings = await window.api.settings.get()
          return {
            claude: settings.agentDefaultArgs?.claude,
            codex: settings.agentDefaultArgs?.codex,
            native: settings.nativeChatPermissionMode
          }
        })
      )
      .toEqual({ claude: '', codex: args, native: 'accept-edits' })
  }

  await claude.click()
  await orcaPage.getByRole('menuitemradio', { name: 'Auto', exact: true }).click()
  await expect(claude).toHaveText('Auto')
  await expect(codex).toHaveText('Auto')
  await orcaPage.reload()
  await orcaPage.waitForFunction(() => Boolean(window.__store))
  await waitForSessionReady(orcaPage)
  await orcaPage.getByRole('button', { name: 'Agents', exact: true }).click()
  await expect(claude).toHaveText('Auto')
  await expect(codex).toHaveText('Auto')
  const saved = await orcaPage.evaluate(() => window.api.settings.get())
  expect(saved.agentDefaultArgs?.['claude-agent-teams']).toBe('')
  expect(saved.nativeChatPermissionMode).toBe('accept-edits')
})
