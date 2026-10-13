import { existsSync } from 'node:fs'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@stablyai/playwright-test'
import { createRestartSession } from './helpers/orca-restart'
import { capturePluginEvidence as capture } from './helpers/plugin-evidence'

async function assertPackagedProfile(
  app: ElectronApplication,
  page: Page,
  userDataDir: string,
  version: string,
  included: boolean
): Promise<Record<string, unknown>> {
  const identity = await app.evaluate(({ app, BrowserWindow }) => {
    const fs = process.getBuiltinModule('fs')
    const path = process.getBuiltinModule('path')
    return {
      version: app.getVersion(),
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
      userData: app.getPath('userData'),
      visible: BrowserWindow.getAllWindows().some((window) => window.isVisible()),
      includedLocale: fs.existsSync(
        path.join(process.resourcesPath, 'plugins', 'launch', 'stablyai.orca-locale-es')
      )
    }
  })
  expect(identity).toMatchObject({
    version,
    packaged: true,
    visible: false,
    includedLocale: included
  })
  expect(identity.appPath).toContain('app.asar')
  expect(await realpath(identity.userData)).toBe(await realpath(userDataDir))
  expect(await page.evaluate(() => Boolean(window.__store))).toBe(false)
  return identity
}

async function openAppearance(page: Page): Promise<void> {
  const appearance = page.getByRole('button', { name: /^(Appearance|Apariencia)$/ })
  if (!(await appearance.isVisible())) {
    await page.getByRole('button', { name: /^(Settings|Ajustes)$/ }).click()
  }
  await appearance.click()
}

async function menuLanguage(app: ElectronApplication, label: 'Edit' | 'Editar'): Promise<void> {
  if (process.platform === 'darwin') {
    await expect
      .poll(() =>
        app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((item) => item.label))
      )
      .toContain(label)
  }
}

test('a real prior release writes language preferences that survive the included-data upgrade and restart', async ({
  browserName: _browserName
}, testInfo) => {
  const prior = process.env.ORCA_PHASE_O_1_PRIOR_EXECUTABLE
  const current = process.env.ORCA_PHASE_O_1_PACKAGED_EXECUTABLE
  test.skip(!prior || !current, 'Provide real prior and current packaged executables')
  test.setTimeout(180_000)
  if (!prior || !current || !existsSync(prior) || !existsSync(current)) {
    throw new Error('Upgrade executables are unavailable')
  }
  const session = createRestartSession(testInfo)
  const documents = join(session.userDataDir, 'Upgrade documents')
  await mkdir(documents)
  const folderPath = await realpath(documents)
  await writeFile(join(folderPath, 'Upgrade.typ'), '#let upgraded = 12pt\n')
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  const identities: Record<string, unknown>[] = []
  const launch = (executablePath: string) =>
    session.launch({ executablePath, waitForStore: false, extraEnv: { NODE_ENV: 'production' } })
  try {
    launched = await launch(prior)
    let { app, page } = launched
    identities.push(await assertPackagedProfile(app, page, session.userDataDir, '1.4.212', false))
    await openAppearance(page)
    await page
      .getByRole('radiogroup', { name: 'Theme', exact: true })
      .getByRole('radio', { name: 'Dark', exact: true })
      .click()
    await page.getByRole('combobox', { name: 'Language', exact: true }).click()
    await page.getByRole('option', { name: /Español/ }).click()
    await expect(page.getByRole('combobox', { name: /^(Idioma|Language)$/ })).toContainText(
      'Español'
    )
    await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    await menuLanguage(app, 'Editar')
    await expect
      .poll(() => page.evaluate(() => window.api.settings.get()))
      .toMatchObject({ uiLanguage: 'es', theme: 'dark', pluginSystemEnabled: false })
    await capture(page, testInfo, 'upgrade-prior-language-preferences', app)
    await session.close(app)
    launched = null

    launched = await launch(current)
    ;({ app, page } = launched)
    identities.push(await assertPackagedProfile(app, page, session.userDataDir, '1.4.214', true))
    await expect
      .poll(() => page.evaluate(() => window.api.settings.get()))
      .toMatchObject({ uiLanguage: 'es', theme: 'dark', pluginSystemEnabled: false })
    const introduction = page.getByRole('dialog', { name: 'Search every agent session' })
    await expect(introduction).toBeVisible()
    await capture(page, testInfo, 'upgrade-current-feature-introduction', app)
    await introduction.locator('[data-slot="dialog-close"]').click()
    await expect(page.locator('[data-slot="dialog-content"]')).toHaveCount(0)
    await openAppearance(page)
    await expect(page.getByRole('combobox', { name: /^(Idioma|Language)$/ })).toContainText(
      'Español'
    )
    await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    await menuLanguage(app, 'Editar')
    await capture(page, testInfo, 'upgrade-current-language-preserved', app)
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    const locale = () => page.locator('[data-bundled-plugin-key="stablyai.orca-locale-es"]')
    const syntax = () => page.locator('[data-bundled-plugin-key="stablyai.orca-syntax-typst"]')
    await expect(locale()).toContainText('v1.0.0')
    await expect(locale().getByRole('switch')).toBeChecked()
    await expect(syntax().getByRole('switch')).toBeChecked()
    await capture(page, testInfo, 'upgrade-current-included-data', app)
    await locale().getByRole('switch').click()
    await expect(locale().getByRole('switch')).not.toBeChecked()
    await menuLanguage(app, 'Edit')
    expect((await page.evaluate(() => window.api.settings.get())).uiLanguage).toBe('es')
    await capture(page, testInfo, 'upgrade-current-language-fallback', app)
    await locale().getByRole('switch').click()
    await expect(locale().getByRole('switch')).toBeChecked()
    await menuLanguage(app, 'Editar')

    await page.getByRole('button', { name: /^(Back to app|Volver a la app)$/ }).click()
    await page.evaluate(async (folderPath) => {
      const group = await window.api.projectGroups.create({
        name: 'Upgrade documents',
        parentPath: folderPath
      })
      await window.api.folderWorkspaces.create({
        projectGroupId: group.id,
        name: 'Upgrade folder',
        folderPath
      })
    }, folderPath)
    await page.getByText('Upgrade folder', { exact: true }).click()
    const explorer = page.getByRole('button', { name: /^(Explorer|Explorador)/ })
    if (!(await explorer.isVisible())) {
      await page
        .getByRole('button', { name: /^(Toggle right sidebar|Alternar barra lateral derecha)$/ })
        .click()
    }
    await explorer.click()
    const row = page
      .locator('[data-file-explorer-row]')
      .filter({ has: page.getByText('Upgrade.typ', { exact: true }) })
    await row.dblclick()
    const line = () => page.locator('.monaco-editor:visible .view-line').first()
    await expect(line()).toContainText('#let upgraded')
    const tokenColors = () =>
      line()
        .locator('span')
        .evaluateAll(
          (spans) =>
            new Set(
              spans
                .filter((span) => !span.childElementCount && span.textContent?.trim())
                .map((span) => getComputedStyle(span).color)
            ).size
        )
    await expect.poll(tokenColors).toBeGreaterThan(1)
    await capture(page, testInfo, 'upgrade-current-included-grammar', app)
    await session.close(app)
    launched = null

    launched = await launch(current)
    ;({ app, page } = launched)
    identities.push(await assertPackagedProfile(app, page, session.userDataDir, '1.4.214', true))
    await expect
      .poll(() => page.evaluate(() => window.api.settings.get()))
      .toMatchObject({ uiLanguage: 'es', theme: 'dark', pluginSystemEnabled: false })
    await page.getByText('Upgrade folder', { exact: true }).click()
    await expect(line()).toContainText('#let upgraded')
    await expect.poll(tokenColors).toBeGreaterThan(1)
    await menuLanguage(app, 'Editar')
    await capture(page, testInfo, 'upgrade-current-restart', app)
    const receipt = JSON.stringify(
      {
        identities,
        finalPreferences: await page
          .evaluate(() => window.api.settings.get())
          .then((settings) => ({
            uiLanguage: settings.uiLanguage,
            theme: settings.theme,
            pluginSystemEnabled: settings.pluginSystemEnabled
          })),
        finalTokenColors: await tokenColors()
      },
      null,
      2
    )
    await testInfo.attach('prior-app-upgrade-identities', {
      body: Buffer.from(receipt),
      contentType: 'application/json'
    })
    await writeFile(
      join(process.cwd(), '.tmp', 'phase-o-1', 'evidence', 'prior-app-upgrade-identities.json'),
      receipt
    )
  } finally {
    try {
      if (launched) {
        await session.close(launched.app)
      }
    } finally {
      await session.dispose()
    }
  }
})
