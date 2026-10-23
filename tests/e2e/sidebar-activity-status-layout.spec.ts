import type { Locator, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type ActivityState = 'idle' | 'working' | 'blocked'

const CASES = [
  { state: 'idle', count: 0 },
  { state: 'working', count: 1 },
  { state: 'working', count: 12 },
  { state: 'working', count: 88 },
  { state: 'working', count: 99 },
  { state: 'working', count: 100 },
  { state: 'blocked', count: 1 },
  { state: 'blocked', count: 12 },
  { state: 'blocked', count: 99 }
] as const

async function seedActivity(
  page: Page,
  worktreeId: string,
  state: ActivityState,
  count: number
): Promise<void> {
  await page.evaluate(
    ({ worktreeId, state, count }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      const tab = store.getState().tabsByWorktree[worktreeId]?.[0]
      if (!tab) {
        throw new Error('The seeded workspace needs a terminal tab')
      }
      store.setState({
        agentStatusByPaneKey: {},
        retainedAgentsByPaneKey: {},
        acknowledgedAgentsByPaneKey: {}
      })
      const now = Date.now()
      for (let index = 0; index < count; index += 1) {
        const leafId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
        store
          .getState()
          .setAgentStatus(
            `${tab.id}:${leafId}`,
            { state, prompt: `Activity layout ${index}`, agentType: 'codex' },
            'Codex',
            { updatedAt: now, stateStartedAt: now },
            { tabId: tab.id, worktreeId, terminalHandle: `activity-layout-${index}` }
          )
      }
    },
    { worktreeId, state, count }
  )
}

async function expectActivityGeometry(button: Locator, state: ActivityState, count: number) {
  const label = state === 'blocked' ? 'Needs You' : state === 'working' ? 'Working' : 'Idle'
  const description = button.locator(`[aria-label="${label}: ${count}"]`)
  await expect(description).toHaveText(count > 99 ? '99+' : String(count))

  const geometry = await button.evaluate((element) => {
    const descriptionId = element.getAttribute('aria-describedby')
    const description = descriptionId ? document.getElementById(descriptionId) : null
    const bell = element.querySelector('svg')
    const statusSlot = description?.firstElementChild
    const status = statusSlot?.firstElementChild
    const countSlot = description?.lastElementChild
    const countText = countSlot?.firstElementChild ?? countSlot
    if (!bell || !status || !countText) {
      throw new Error('Activity glyphs are missing')
    }
    const textRange = document.createRange()
    textRange.selectNodeContents(countText)
    const rect = (value: DOMRect) => ({
      left: value.left,
      right: value.right,
      top: value.top,
      bottom: value.bottom,
      width: value.width,
      height: value.height,
      centerX: value.left + value.width / 2
    })
    return {
      button: rect(element.getBoundingClientRect()),
      bell: rect(bell.getBoundingClientRect()),
      status: rect(status.getBoundingClientRect()),
      count: rect(textRange.getBoundingClientRect())
    }
  })

  expect(geometry.button.width, 'The control must keep its existing width').toBe(24)
  expect(geometry.button.height, 'The control must keep its existing height').toBe(24)
  expect(geometry.bell.right, 'The count must not overlap the bell').toBeLessThanOrEqual(
    geometry.count.left + 0.25
  )
  expect(
    Math.abs(geometry.status.centerX - geometry.count.centerX),
    'The status and count must share a vertical axis'
  ).toBeLessThanOrEqual(0.25)
  expect(geometry.status.bottom, 'The status must clear the count').toBeLessThanOrEqual(
    geometry.count.top + 0.25
  )
  for (const [name, glyph] of Object.entries({
    bell: geometry.bell,
    status: geometry.status,
    count: geometry.count
  })) {
    expect(glyph.width, `${name} must be rendered`).toBeGreaterThan(0)
    expect(glyph.left, `${name} must fit the left edge`).toBeGreaterThanOrEqual(
      geometry.button.left - 0.25
    )
    expect(glyph.right, `${name} must fit the right edge`).toBeLessThanOrEqual(
      geometry.button.right + 0.25
    )
    expect(glyph.top, `${name} must fit the top edge`).toBeGreaterThanOrEqual(
      geometry.button.top - 0.25
    )
    expect(glyph.bottom, `${name} must fit the bottom edge`).toBeLessThanOrEqual(
      geometry.button.bottom + 0.25
    )
  }
}

for (const theme of ['dark', 'light'] as const) {
  test(`activity counts clear the bell and align with their status (${theme})`, async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)
    await orcaPage.evaluate(async (theme) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      await store.getState().updateSettings({ theme, agentsSidebarIntroShown: true })
      store.getState().setSidebarBody('workspaces')
    }, theme)
    await expect(orcaPage.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /\blight\b/)

    for (const sidebarBody of ['workspaces', 'agents'] as const) {
      if (sidebarBody === 'agents') {
        await orcaPage.getByRole('button', { name: 'View activity', exact: true }).click()
      }
      const button = orcaPage.getByRole('button', {
        name: sidebarBody === 'agents' ? 'Turn off activity view' : 'View activity',
        exact: true
      })
      for (const { state, count } of CASES) {
        await test.step(`${sidebarBody}: ${state} ${count}`, async () => {
          await seedActivity(orcaPage, worktreeId, state, count)
          await expectActivityGeometry(button, state, count)
        })
      }
    }
  })
}
