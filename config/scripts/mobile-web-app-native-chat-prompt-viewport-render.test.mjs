import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as esbuild from 'esbuild'
import { chromium } from 'playwright-core'
import {
  MOBILE_WEB_APP_NATIVE_PARITY_STYLE,
  MOBILE_WEB_APP_ROOT_RESET,
  mobileWebAppBuildOptions
} from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { createBundleServer, projectDir } from './mobile-web-app-render-harness.mjs'
import {
  nativeChatPromptViewportFixture,
  PROMPT_QUESTION
} from './mobile-web-app-native-chat-prompt-viewport-fixture.mjs'

const bundles = mobileWebAppDependenciesPresent()
const describeRender = bundles ? describe : describe.skip
const artifactDir = process.env.ORCA_MOBILE_PROMPT_VIEWPORT_ARTIFACT_DIR
let browser = null
let origin = null
let scratch = null
let server = null

beforeAll(async () => {
  if (!bundles) {
    return
  }
  scratch = await mkdtemp(join(tmpdir(), 'orca-native-chat-prompt-viewport-'))
  const outDir = join(scratch, 'bundle')
  const sessionDir = join(projectDir, 'mobile', 'src', 'session')
  await mkdir(outDir)
  await esbuild.build({
    ...mobileWebAppBuildOptions([]),
    entryPoints: undefined,
    entryNames: 'app',
    stdin: {
      contents: nativeChatPromptViewportFixture({
        chatViewModule: join(sessionDir, 'MobileNativeChatView'),
        clientContextModule: join(sessionDir, '../transport/client-context.web')
      }),
      resolveDir: sessionDir,
      loader: 'tsx',
      sourcefile: 'native-chat-prompt-viewport.tsx'
    },
    outdir: outDir,
    splitting: false,
    write: true,
    metafile: false
  })
  await writeFile(
    join(outDir, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      ${MOBILE_WEB_APP_ROOT_RESET}${MOBILE_WEB_APP_NATIVE_PARITY_STYLE}
      </head><body><div id="root" style="display:flex;flex-direction:column;height:100dvh"></div>
      <script type="module" src="/app.js"></script></body></html>`
  )
  const served = await createBundleServer({ outDir })
  server = served.server
  origin = served.origin
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  if (artifactDir) {
    await mkdir(artifactDir, { recursive: true })
  }
}, 180_000)

afterAll(async () => {
  await browser?.close()
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

async function openPrompt(viewport, query = '') {
  const page = await browser.newPage({ viewport })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${origin}/${query}`)
  await page
    .getByText(
      query.includes('terminal')
        ? 'Answer this OMP question in the terminal.'
        : query.includes('short')
          ? 'Continue?'
          : PROMPT_QUESTION,
      { exact: true }
    )
    .waitFor()
  return { page, errors }
}

async function readPromptLayout(page, footerLabel = 'Submit') {
  return page.evaluate(
    ({ question, footerLabel }) => {
      const rect = (node) => {
        if (!node) {
          throw new Error('Missing chat layout element')
        }
        const { top, bottom, height } = node.getBoundingClientRect()
        return {
          top,
          bottom,
          height,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight
        }
      }
      const scrolls = [...document.querySelectorAll('*')].filter((node) =>
        ['auto', 'scroll'].includes(getComputedStyle(node).overflowY)
      )
      const chat = scrolls.find((node) => node.textContent.includes('Chat context'))
      const prompt = scrolls.find((node) => node.textContent.includes(question))
      const text = [...document.querySelectorAll('*')].find(
        (node) => node.childElementCount === 0 && node.textContent === footerLabel
      )
      const cancel = [...document.querySelectorAll('*')].find(
        (node) => node.childElementCount === 0 && node.textContent === 'Cancel'
      )
      return {
        chat: rect(chat),
        prompt: rect(prompt),
        footerInScroll: prompt.contains(text?.parentElement),
        footer: rect(text?.parentElement?.parentElement),
        submit: rect(text?.parentElement),
        cancel: rect(cancel?.parentElement),
        composer: rect(document.querySelector('[data-testid="native-chat-composer-inset"]')),
        documentHeight: document.documentElement.scrollHeight,
        viewportHeight: innerHeight
      }
    },
    { question: PROMPT_QUESTION, footerLabel }
  )
}

async function recordLayout(page, name, layout) {
  if (!artifactDir) {
    return
  }
  await writeFile(join(artifactDir, `${name}.json`), JSON.stringify(layout, null, 2))
  await page.screenshot({ path: join(artifactDir, `${name}.png`) })
}

async function scrollQuestionToEnd(page) {
  return page.evaluate((question) => {
    const prompt = [...document.querySelectorAll('*')].find(
      (node) =>
        ['auto', 'scroll'].includes(getComputedStyle(node).overflowY) &&
        node.textContent.includes(question)
    )
    prompt.scrollTop = prompt.scrollHeight
    return prompt.scrollTop
  }, PROMPT_QUESTION)
}

const CASES = [
  { width: 375, height: 650, keyboard: 0 },
  { width: 315, height: 540, keyboard: 0 },
  { width: 375, height: 350, keyboard: 0 },
  { width: 375, height: 650, keyboard: 300 },
  { width: 375, height: 350, keyboard: 0, steps: true }
]

const INSET_CASES = [
  { width: 375, height: 650, keyboard: 300, bottom: 34, chrome: 0 },
  { width: 375, height: 650, keyboard: 250, bottom: 34, chrome: 88 },
  { width: 375, height: 650, keyboard: 300, bottom: 34, chrome: 88 }
]

describeRender('native chat question cards in a constrained viewport', () => {
  it('keeps an editable draft mounted while rotating an open question above the keyboard', async () => {
    const { page, errors } = await openPrompt(
      { width: 402, height: 874 },
      '?keyboard=208&bottom=21&chrome=62'
    )
    try {
      const composer = page.getByPlaceholder('Ask anything, @ to mention files, / for commands')
      await composer.fill('Draft survives rotation\n'.repeat(8))
      await composer.evaluate((node) => {
        node.dataset.rotationWitness = 'same-field'
      })
      await page.setViewportSize({ width: 874, height: 402 })
      await expect.poll(async () => (await readPromptLayout(page)).chat.height).toBeGreaterThan(24)
      const layout = await readPromptLayout(page)
      expect(layout.composer.height).toBeLessThan(80)
      expect(layout.prompt.height).toBeGreaterThanOrEqual(22)
      expect(layout.composer.bottom).toBeLessThanOrEqual(402 - 208 - 21 + 1)
      expect(layout.documentHeight).toBeLessThanOrEqual(402)
      await composer.fill('Edited in landscape')
      expect(await composer.getAttribute('data-rotation-witness')).toBe('same-field')
      await page.getByText(PROMPT_QUESTION, { exact: true }).click()
      await scrollQuestionToEnd(page)
      await page.getByText('Other…', { exact: true }).click()
      await page.getByPlaceholder('Type your answer', { exact: true }).fill('Keep context')
      expect(await composer.isVisible()).toBe(false)
      await page.getByText('Submit', { exact: true }).click()
      expect(await page.evaluate(() => globalThis.__orcaPromptViewportAnswers)).toEqual([
        { indices: [], other: 'Keep context' }
      ])
      await page.evaluate(() => {
        for (const node of document.querySelectorAll('*')) {
          if (['auto', 'scroll'].includes(getComputedStyle(node).overflowY)) {
            node.scrollTop = 0
          }
        }
      })
      await page.getByLabel('Collapse', { exact: true }).click()
      expect(await composer.inputValue()).toBe('Edited in landscape')
      await composer.focus()
      expect(await composer.isVisible()).toBe(true)
      await page.getByLabel('Expand', { exact: true }).click()
      expect(await page.getByPlaceholder('Type your answer', { exact: true }).inputValue()).toBe(
        'Keep context'
      )
      await scrollQuestionToEnd(page)
      await page.getByText('Cancel', { exact: true }).click()
      expect(await page.evaluate(() => globalThis.__orcaPromptViewportCancels)).toBe(1)
      await page.setViewportSize({ width: 402, height: 874 })
      expect(await composer.getAttribute('data-rotation-witness')).toBe('same-field')
      expect(await composer.inputValue()).toBe('Edited in landscape')
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  it('keeps terminal-only question navigation reachable above the keyboard', async () => {
    const { page, errors } = await openPrompt(
      { width: 375, height: 650 },
      '?terminal=1&keyboard=300&bottom=34&chrome=88'
    )
    try {
      const answer = page.getByRole('button', { name: 'Answer in terminal', exact: true })
      await answer.scrollIntoViewIfNeeded()
      await answer.click()
      expect(await page.evaluate(() => globalThis.__orcaPromptViewportTerminalNavigations)).toBe(1)
      const layout = await answer.boundingBox()
      expect(layout.y + layout.height).toBeLessThanOrEqual(650 - 300 - 34)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  it.each(INSET_CASES)(
    'keeps a readable question with safe area $bottom, keyboard $keyboard and session chrome $chrome',
    async ({ width, height, keyboard, bottom, chrome }) => {
      const { page, errors } = await openPrompt(
        { width, height },
        `?keyboard=${keyboard}&bottom=${bottom}&chrome=${chrome}`
      )
      try {
        await expect.poll(async () => (await readPromptLayout(page)).footerInScroll).toBe(true)
        const layout = await readPromptLayout(page)
        await recordLayout(
          page,
          `${width}-${height}-keyboard-${keyboard}-bottom-${bottom}-chrome-${chrome}`,
          layout
        )
        expect(
          layout.prompt.height,
          'the question retains a readable scroll viewport'
        ).toBeGreaterThanOrEqual(44)
        expect(layout.chat.height, 'some transcript context stays visible').toBeGreaterThanOrEqual(
          24
        )
        expect(layout.composer.bottom).toBeLessThanOrEqual(height - keyboard - bottom + 1)
        expect(layout.documentHeight).toBeLessThanOrEqual(height)
        expect(layout.footerInScroll).toBe(true)
        expect(await scrollQuestionToEnd(page)).toBeGreaterThan(0)
        const controls = await readPromptLayout(page)
        await recordLayout(
          page,
          `${width}-${height}-keyboard-${keyboard}-bottom-${bottom}-chrome-${chrome}-controls`,
          controls
        )
        for (const action of [controls.cancel, controls.submit]) {
          expect(action.top).toBeGreaterThanOrEqual(controls.prompt.top)
          expect(action.bottom).toBeLessThanOrEqual(controls.prompt.bottom)
        }
        await page.getByText('Cancel', { exact: true }).click()
        expect(await page.evaluate(() => globalThis.__orcaPromptViewportCancels)).toBe(1)
        await page.getByText('Persist across reload', { exact: true }).click()
        await page.getByText('Submit', { exact: true }).click()
        expect(await page.evaluate(() => globalThis.__orcaPromptViewportAnswers)).toEqual([
          { indices: [0] }
        ])
        expect(errors).toEqual([])
      } finally {
        await page.close()
      }
    }
  )

  it.each(CASES)(
    'shares $width×$height with keyboard lift $keyboard and steps $steps',
    async (testCase) => {
      const { width, height, keyboard, steps } = testCase
      const { page, errors } = await openPrompt(
        { width, height },
        `?keyboard=${keyboard}${steps ? '&steps=2' : ''}`
      )
      try {
        const layout = await readPromptLayout(page, steps ? 'Next' : 'Submit')
        await recordLayout(
          page,
          `${width}-${height}-keyboard-${keyboard}${steps ? '-steps' : ''}`,
          layout
        )
        const available = layout.composer.top - layout.chat.top
        expect(
          layout.chat.height,
          'chat keeps at least half the space above the composer'
        ).toBeGreaterThanOrEqual(available / 2 - 1)
        expect(
          layout.prompt.height,
          'the scrollable body retains a usable reading area'
        ).toBeGreaterThanOrEqual(44)
        expect(layout.prompt.scrollHeight).toBeGreaterThan(layout.prompt.clientHeight)
        expect(layout.chat.bottom).toBeLessThanOrEqual(layout.prompt.top + 1)
        expect(layout.prompt.bottom).toBeLessThanOrEqual(layout.footer.top + 1)
        expect(layout.submit.bottom).toBeLessThanOrEqual(layout.composer.top)
        expect(layout.cancel.bottom).toBeLessThanOrEqual(layout.composer.top)
        expect(layout.composer.bottom).toBeLessThanOrEqual(height - keyboard + 1)
        expect(layout.documentHeight).toBeLessThanOrEqual(height)
        const scrolled = await scrollQuestionToEnd(page)
        expect(scrolled, 'the question body actually scrolls').toBeGreaterThan(0)
        expect((await readPromptLayout(page, steps ? 'Next' : 'Submit')).footer).toEqual(
          layout.footer
        )
        expect(errors).toEqual([])
      } finally {
        await page.close()
      }
    }
  )

  it('returns to a fixed footer when space grows and settles again when it shrinks', async () => {
    const { page, errors } = await openPrompt(
      { width: 375, height: 650 },
      '?keyboard=300&bottom=34&chrome=88'
    )
    try {
      expect((await readPromptLayout(page)).footerInScroll).toBe(true)
      await page.setViewportSize({ width: 375, height: 950 })
      await expect.poll(async () => (await readPromptLayout(page)).footerInScroll).toBe(false)
      const expanded = await readPromptLayout(page)
      expect(expanded.prompt.height).toBeGreaterThanOrEqual(44)
      expect(expanded.footer.bottom).toBeLessThanOrEqual(expanded.composer.top)
      await page.setViewportSize({ width: 375, height: 650 })
      await expect.poll(async () => (await readPromptLayout(page)).footerInScroll).toBe(true)
      const settled = await readPromptLayout(page)
      for (let frame = 0; frame < 4; frame++) {
        await page.evaluate(() => new Promise(requestAnimationFrame))
        expect(await readPromptLayout(page)).toEqual(settled)
      }
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  it('keeps a short question compact instead of filling half the conversation', async () => {
    const { page, errors } = await openPrompt({ width: 375, height: 900 }, '?short=1')
    try {
      const chatHeight = await page.evaluate(() => {
        const chat = [...document.querySelectorAll('*')].find(
          (node) =>
            ['auto', 'scroll'].includes(getComputedStyle(node).overflowY) &&
            node.textContent.includes('Chat context')
        )
        return chat.getBoundingClientRect().height
      })
      expect(chatHeight).toBeGreaterThan(550)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })

  it.each(['', '?keyboard=300&bottom=34&chrome=88'])(
    'retains selections and Other text after collapse and expand, with %s',
    async (query) => {
      const { page, errors } = await openPrompt(
        query ? { width: 375, height: 650 } : { width: 315, height: 540 },
        query
      )
      try {
        await page.getByText('Persist across reload', { exact: true }).click()
        await page.getByText('Other…', { exact: true }).click()
        await page
          .getByPlaceholder('Type your answer', { exact: true })
          .fill('Keep this answer after folding')
        await page.getByLabel('Collapse', { exact: true }).click()
        expect(await page.getByTestId('native-chat-prompt-strip').isVisible()).toBe(true)
        await page.getByLabel('Expand', { exact: true }).click()
        expect(await page.getByPlaceholder('Type your answer', { exact: true }).inputValue()).toBe(
          'Keep this answer after folding'
        )
        await page.getByText('Submit', { exact: true }).click()
        expect(await page.evaluate(() => globalThis.__orcaPromptViewportAnswers)).toEqual([
          { indices: [0], other: 'Keep this answer after folding' }
        ])
        expect(errors).toEqual([])
      } finally {
        await page.close()
      }
    }
  )
})
