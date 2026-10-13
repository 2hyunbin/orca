import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test, type Page } from '@stablyai/playwright-test'
import { createDirectoryFixtureServer } from './directory-fixture-server'
import {
  captureDirectoryScreenshot as screenshot,
  assertDirectoryWithinViewport as noOverflow,
  assertDirectoryCategoryLayout
} from './directory-browser-evidence'

let fixture: Awaited<ReturnType<typeof createDirectoryFixtureServer>>
const openDirectory = async (page: Page): Promise<void> => {
  await page.goto(fixture.url)
  await expect(
    page.getByRole('button', { name: 'View Portuguese (Brazil)', exact: true })
  ).toBeVisible()
}

test.beforeAll(async () => {
  fixture = await createDirectoryFixtureServer()
})
test.afterAll(async () => {
  if (fixture) {
    await fixture.close()
  }
})

test('a build with an invalid catalog preserves the previous production output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-directory-invalid-build-'))
  const index = resolve('out/plugin-directory/index.html')
  const before = await readFile(index)
  try {
    const input = join(root, 'catalog.json')
    await writeFile(input, JSON.stringify({ ...fixture.directory.catalog, official: true }))
    await expect(
      promisify(execFile)(
        process.execPath,
        [
          'config/scripts/run-plugin-directory-build.mjs',
          '--catalog',
          input,
          '--source-url',
          fixture.directory.source.url,
          '--source-ref',
          fixture.directory.source.ref
        ],
        { timeout: 30_000, maxBuffer: 1024 * 1024 }
      )
    ).rejects.toThrow()
    expect(await readFile(index)).toEqual(before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('storage denial does not prevent fresh browsing and an empty catalog has a useful state', async ({
  page
}) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error('denied')
    }
    Storage.prototype.setItem = () => {
      throw new Error('denied')
    }
  })
  await openDirectory(page)
  await page.getByRole('button', { name: 'Use dark theme' }).click()
  await expect(page.getByRole('button', { name: 'Use light theme' })).toBeVisible()
  await page.route('**/directory-catalog.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ...fixture.directory,
        catalog: { ...fixture.directory.catalog, plugins: [] }
      })
    })
  )
  await page.reload()
  await expect(page.getByRole('heading', { name: 'No plugins listed' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Clear filters' })).toHaveCount(0)
  await expect(
    page.getByRole('link', { name: 'Contribute a plugin to this catalog' })
  ).toBeVisible()
})

test('real fixture releases appear with searchable categories, theme persistence and narrow layouts', async ({
  page
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await openDirectory(page)
  await expect(page.getByRole('button', { name: /^View / })).toHaveCount(
    fixture.directory.catalog.plugins.length
  )
  await page.getByRole('button', { name: 'Use dark theme' }).click()
  await screenshot(page, 'directory-dark-catalog')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Use light theme' })).toBeVisible()
  await page.route('**/assets/index-*.js', (route) => route.abort())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('html')).toHaveClass(/dark/)
  expect(await page.locator('#root').evaluate((element) => element.childElementCount)).toBe(0)
  await page.unroute('**/assets/index-*.js')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Use light theme' })).toBeVisible()
  await page.getByRole('tab', { name: 'Coding languages', exact: true }).click()
  await expect(page.getByRole('button', { name: 'View Typst syntax' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'View XLSX tables' })).toHaveCount(0)
  await page.getByRole('tab', { name: 'All plugins', exact: true }).click()
  await page.getByRole('textbox', { name: 'Search plugins' }).fill('fixture-author')
  await expect(page.getByRole('button', { name: /^View / })).toHaveCount(3)
  await screenshot(page, 'directory-community-search')
  await page.getByRole('button', { name: 'Clear search' }).click()
  await expect(page.getByRole('textbox', { name: 'Search plugins' })).toBeFocused()
  await page.getByRole('button', { name: 'Use light theme' }).click()
  await screenshot(page, 'directory-light-catalog')
  await page.setViewportSize({ width: 390, height: 844 })
  await noOverflow(page)
  await assertDirectoryCategoryLayout(page)
  await screenshot(page, 'directory-mobile-catalog')
  await page.getByRole('button', { name: 'View XLSX tables' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await noOverflow(page)
  await screenshot(page, 'directory-mobile-detail')
  await page.getByText('Release details', { exact: true }).click()
  const release = fixture.directory.catalog.plugins.find(
    (plugin) => plugin.id === 'stablyai.orca-viewer-xlsx'
  )!
  await page
    .getByRole('dialog')
    .getByText(release.release.contentHash, { exact: true })
    .scrollIntoViewIfNeeded()
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true })
  ).toBeInViewport()
  await noOverflow(page)
  await screenshot(page, 'directory-mobile-release')
  expect(errors).toEqual([])
})

test('environment providers have a category and require review before enabling', async ({
  page
}) => {
  await openDirectory(page)
  await page.getByRole('tab', { name: 'Environment providers', exact: true }).click()
  await expect(page.getByRole('button', { name: /^View / })).toHaveCount(1)
  await expect(
    page.getByRole('button', { name: 'View Development environments', exact: true })
  ).toContainText('Environment provider')
  await page.getByRole('button', { name: 'View Development environments', exact: true }).click()
  const detail = page.getByRole('dialog')
  await expect(detail.getByText('Review before enabling', { exact: true })).toBeVisible()
  await expect(detail).toContainText('Commands run with your account on the selected host.')
  await expect(detail.getByRole('region', { name: 'Publisher preview' })).toContainText(
    'Create · list · sleep · wake · archive · delete'
  )
  await screenshot(page, 'directory-environment-provider-review')
  await page.keyboard.press('Escape')
  await expect(detail).toBeHidden()
  await expect(
    page.getByRole('button', { name: 'View Development environments', exact: true })
  ).toBeFocused()
})

test('keyboard details expose exact installed-release metadata and copy the supported Git catalog', async ({
  page,
  context
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openDirectory(page)
  const trigger = page.getByRole('button', { name: 'View XLSX tables' })
  await trigger.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Review before enabling' })).toBeVisible()
  await expect(dialog.getByRole('textbox', { name: 'Catalog Git URL' })).toHaveValue(
    fixture.directory.source.url
  )
  await dialog.getByRole('button', { name: 'Copy catalog git url' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    fixture.directory.source.url
  )
  await dialog.getByText('Release details', { exact: true }).click()
  const release = fixture.directory.catalog.plugins.find(
    (plugin) => plugin.id === 'stablyai.orca-viewer-xlsx'
  )!
  await expect(dialog.getByText(release.release.commit, { exact: true })).toBeVisible()
  await expect(dialog.getByText(release.release.contentHash, { exact: true })).toBeVisible()
  await screenshot(page, 'directory-pinned-viewer-detail')
  await writeFile(
    resolve('.tmp/phase-o-1/evidence/directory-release-proof.json'),
    JSON.stringify(
      {
        package: release.id,
        source: release.source,
        catalog: fixture.directory.source,
        displayedCommit: await dialog
          .getByText(release.release.commit, { exact: true })
          .innerText(),
        displayedHash: await dialog
          .getByText(release.release.contentHash, { exact: true })
          .innerText(),
        browserClipboardMatches: true,
        nativeOSClipboardClaim: false
      },
      null,
      2
    )
  )
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(trigger).toBeFocused()
  await page.getByRole('tab', { name: 'Coding languages', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: 'File viewers', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  )
})

test('denied clipboard has an accessible selected-value fallback and IME Escape keeps the modal open', async ({
  page
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('denied')
        }
      }
    })
  })
  await openDirectory(page)
  await page.getByRole('button', { name: 'View Portuguese (Brazil)', exact: true }).click()
  await page.getByRole('button', { name: 'Copy catalog git url' }).click()
  const input = page.getByRole('textbox', { name: 'Catalog Git URL' })
  await expect(input).toBeFocused()
  await expect(page.getByText(/Clipboard unavailable/)).toBeVisible()
  expect(
    await input.evaluate(
      (element: HTMLInputElement) => element.selectionEnd! - element.selectionStart!
    )
  ).toBe(fixture.directory.source.url.length)
  await input.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        isComposing: true,
        bubbles: true,
        cancelable: true
      })
    )
  )
  await expect(page.getByRole('dialog')).toBeVisible()
  await screenshot(page, 'directory-copy-fallback')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: () =>
          new Promise<void>((_resolve, reject) => {
            addEventListener('test-reject-copy', () => reject(new Error('denied')), { once: true })
          })
      }
    })
  })
  await page.getByRole('button', { name: 'View Portuguese (Brazil)', exact: true }).click()
  await page.getByRole('button', { name: 'Copy catalog git url' }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'View XLSX tables' }).click()
  const currentRef = page.getByRole('textbox', { name: 'Catalog ref' })
  await currentRef.focus()
  await page.evaluate(() => dispatchEvent(new Event('test-reject-copy')))
  await expect(currentRef).toBeFocused()
  await expect(page.getByText(/Clipboard unavailable/)).toHaveCount(0)
})

test('offline cached browsing retains the search and recovers; a cold invalid catalog fails closed', async ({
  page
}) => {
  await openDirectory(page)
  await page.route('**/directory-catalog.json', (route) => route.abort())
  await page.reload()
  await expect(page.getByText(/Could not refresh/)).toBeVisible()
  await page.getByRole('textbox', { name: 'Search plugins' }).fill('typst')
  await expect(page.getByRole('button', { name: /^View / })).toHaveCount(1)
  await screenshot(page, 'directory-cached-offline')
  await page.unroute('**/directory-catalog.json')
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByText(/Could not refresh/)).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Search plugins' })).toHaveValue('typst')
  await page.evaluate(() => localStorage.clear())
  await page.route('**/directory-catalog.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ...fixture.directory, official: true })
    })
  )
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Catalog unavailable' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^View / })).toHaveCount(0)
  await screenshot(page, 'directory-invalid-catalog')
  await page.unroute('**/directory-catalog.json')
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('button', { name: 'View Typst syntax' })).toBeVisible()
})

test('untrusted previews stay literal, SSH stays copy-only, and large indexes stay bounded and searchable', async ({
  page
}) => {
  const input = structuredClone(fixture.directory)
  const sample = input.catalog.plugins[0]!
  sample.source.url = 'git@example.org:locale.git'
  sample.release.preview = {
    title: 'Literal preview',
    text: '<img src="https://example.org/never" onerror="window.injected=true"><script>window.injected=true</script>'
  }
  input.catalog.plugins = Array.from({ length: 100 }, (_unused, index) => ({
    ...sample,
    id: `community.package-${index}`,
    name: `Community example ${index}`
  }))
  const external: string[] = []
  page.on('request', (request) => {
    if (!request.url().startsWith(fixture.url)) {
      external.push(request.url())
    }
  })
  await page.route('**/directory-catalog.json', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(input) })
  )
  await page.goto(fixture.url)
  await expect(page.getByRole('button', { name: /^View / })).toHaveCount(24)
  await page.getByRole('button', { name: /Show more plugins/ }).click()
  await expect(page.getByRole('button', { name: /^View / })).toHaveCount(48)
  await page.getByRole('textbox', { name: 'Search plugins' }).fill('example 99')
  await page.getByRole('button', { name: 'View Community example 99', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('link', { name: 'Source' })).toHaveCount(0)
  await expect(dialog.getByLabel('Publisher preview')).toContainText(
    '<script>window.injected=true</script>'
  )
  expect(await page.evaluate(() => 'injected' in window)).toBe(false)
  expect(external).toEqual([])
  await page.keyboard.press('Escape')
  await page.getByRole('textbox', { name: 'Search plugins' }).fill('missing result')
  await expect(page.getByRole('heading', { name: 'No plugins match' })).toBeVisible()
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(page.getByRole('button', { name: /^View / })).toHaveCount(24)
})

test('contradictory execution claims cannot replace a validated public catalog', async ({
  page
}) => {
  const invalid = structuredClone(fixture.directory)
  invalid.catalog.plugins[0]!.name = 'Misleading worker release'
  invalid.catalog.plugins[0]!.release.types = ['worker']
  let response = invalid
  await page.route('**/directory-catalog.json', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) })
  )
  await page.goto(fixture.url)
  await expect(page.getByRole('heading', { name: 'Catalog unavailable' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^View / })).toHaveCount(0)
  await screenshot(page, 'adversarial-directory-invalid-execution')
  response = fixture.directory
  await page.getByRole('button', { name: 'Try again' }).click()
  const language = page.getByRole('button', { name: 'View Portuguese (Brazil)', exact: true })
  await expect(language).toContainText('Declared data pack')
  await expect(language.getByLabel('Publisher preview')).toContainText('Abrir arquivo')
  await screenshot(page, 'adversarial-directory-declarations')
  response = invalid
  await page.reload()
  await expect(page.getByText(/Could not refresh/)).toBeVisible()
  await expect(language).toBeVisible()
  await expect(page.getByText('Misleading worker release', { exact: true })).toHaveCount(0)
  await screenshot(page, 'adversarial-directory-valid-cache')
})
