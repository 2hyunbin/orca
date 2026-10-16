import { writeFileSync } from 'node:fs'
import type { Page } from '@stablyai/playwright-test'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedWebClient, type PairedWebClient } from './helpers/paired-electron-client'
import { callColdActivationRuntime } from './helpers/paired-terminal-cold-activation-observation'
import { createPairedTerminalParkingFixture } from './helpers/paired-terminal-parking-fixture'
import { getTerminalContent, waitForActivePanePtyId } from './helpers/terminal'

// The most recent TERMINAL_WORKTREE_HOT_RETAIN_LIMIT worktrees stay warm, so park needs more.
const WARM_WORKTREE_COUNT = 4

type MountSample = {
  t: number
  /** The revealed pane's screen is effectively visible (no hidden or transparent ancestor). */
  revealedShown: boolean
  revealedInk: boolean
  /** Terminal screens effectively visible anywhere in the window. */
  visibleScreens: number
}

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Window augmentation requires declaration merging.
  interface Window {
    __parkedRevealMountProbe?: { stop: () => MountSample[] }
  }
}

// Samples every frame, tick and xterm render from the switch until the revealed pane paints.
async function startMountProbe(page: Page, tabId: string): Promise<void> {
  await page.evaluate((target) => {
    const samples: MountSample[] = []
    const started = performance.now()
    const observed = new WeakSet<object>()
    let running = true
    const shown = (element: HTMLElement): boolean => {
      if (element.getClientRects().length === 0 || element.getBoundingClientRect().width === 0) {
        return false
      }
      for (let node: HTMLElement | null = element; node; node = node.parentElement) {
        if (getComputedStyle(node).opacity === '0') {
          return false
        }
      }
      return true
    }
    const sample = (): void => {
      const terminal = window.__paneManagers?.get(target)?.getActivePane()?.terminal
      const screen = terminal?.element?.querySelector<HTMLElement>('.xterm-screen') ?? null
      let revealedInk = false
      if (terminal && screen) {
        if (!observed.has(terminal)) {
          observed.add(terminal)
          terminal.onRender(sample)
        }
        const buffer = terminal.buffer.active
        for (let row = 0; row < terminal.rows && !revealedInk; row += 1) {
          revealedInk =
            (buffer
              .getLine(buffer.viewportY + row)
              ?.translateToString(true)
              .trim() ?? '') !== ''
        }
      }
      samples.push({
        t: Math.round(performance.now() - started),
        revealedShown: screen !== null && shown(screen),
        revealedInk,
        visibleScreens: Array.from(document.querySelectorAll<HTMLElement>('.xterm-screen')).filter(
          shown
        ).length
      })
    }
    const interval = window.setInterval(sample, 4)
    const onFrame = (): void => {
      if (running) {
        sample()
        requestAnimationFrame(onFrame)
      }
    }
    requestAnimationFrame(onFrame)
    window.__parkedRevealMountProbe = {
      stop: () => {
        running = false
        window.clearInterval(interval)
        return samples
      }
    }
  }, tabId)
}

test('switching to a parked paired terminal never shows its empty remounted pane', async ({
  testRepoPath
}) => {
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost()
  const fixture = createPairedTerminalParkingFixture()
  let client: PairedWebClient | null = null
  try {
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: testRepoPath,
      kind: 'git'
    })
    client = await launchPairedWebClient(host.app, host.offer, { terminalParkingDelayMs: 100 })
    const page = client.page
    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().allWorktrees().length ?? 0), {
        timeout: 30_000
      })
      .toBeGreaterThan(0)
    await page.evaluate(async () => {
      await window.__store?.getState().updateSettings({
        terminalHiddenViewParking: true,
        terminalHiddenWorktreeRetentionBudget: false
      })
    })
    const marker = `PARKED_MOUNT_${Date.now()}`
    const worktrees: { worktreeId: string; terminal: string; tabId: string }[] = []
    for (let index = 0; index <= WARM_WORKTREE_COUNT; index += 1) {
      const created = await callColdActivationRuntime<{
        startupTerminal?: { handle?: string; tabId?: string }
        worktree: { id: string }
      }>(page, 'worktree.create', {
        repo: added.result.repo.id,
        name: `parked-mount-${Date.now()}-${index}`,
        setupDecision: 'skip',
        activate: false,
        noParent: true,
        startupCommand: fixture.command(`${marker}_${index}`)
      })
      const handle = created.startupTerminal?.handle
      const hostTabId = created.startupTerminal?.tabId
      if (!handle || !hostTabId) {
        throw new Error(`Parked-mount startup terminal ${index} was not created`)
      }
      worktrees.push({
        worktreeId: created.worktree.id,
        terminal: handle,
        tabId: toWebTerminalSurfaceTabId(hostTabId)
      })
    }
    const openTab = async (entry: { worktreeId: string; tabId: string }): Promise<void> => {
      await page.evaluate((id) => {
        const state = window.__store?.getState()
        state?.setActiveView('terminal')
        state?.setActiveWorktree(id)
      }, entry.worktreeId)
      const tab = page.locator(`[data-testid="sortable-tab"][data-tab-id="${entry.tabId}"]`)
      await expect(tab).toBeVisible({ timeout: 30_000 })
      await tab.click()
      await waitForActivePanePtyId(page, 30_000)
    }
    const target = worktrees[0]
    await openTab(target)
    await callColdActivationRuntime(page, 'terminal.send', {
      terminal: target.terminal,
      text: 'FILL',
      enter: true,
      client: { id: 'parked-mount-e2e', type: 'desktop' }
    })
    await expect
      .poll(() => getTerminalContent(page), { timeout: 30_000 })
      .toContain(`FILLED:${marker}_0`)
    // Visiting the others parks the target; the last one stays on screen as the outgoing workspace.
    for (const warm of worktrees.slice(1)) {
      await openTab(warm)
    }
    await expect
      .poll(
        () =>
          page.evaluate(
            (id) =>
              !window.__paneManagers?.has(id) &&
              (window.__terminalParkingDebug?.parkedTabIds() ?? []).includes(id),
            target.tabId
          ),
        { timeout: 30_000 }
      )
      .toBe(true)

    await startMountProbe(page, target.tabId)
    await page.evaluate((id) => window.__store?.getState().setActiveWorktree(id), target.worktreeId)
    await expect
      .poll(() => getTerminalContent(page), { timeout: 30_000 })
      .toContain(`FILLED:${marker}_0`)
    await page.waitForTimeout(1_000)
    const samples = await page.evaluate(() => window.__parkedRevealMountProbe?.stop() ?? [])
    const samplesPath = test.info().outputPath('parked-reveal-mount-samples.json')
    writeFileSync(samplesPath, JSON.stringify(samples, null, 2))
    await test.info().attach('parked-reveal-mount-samples', {
      path: samplesPath,
      contentType: 'application/json'
    })

    const firstShown = samples.findIndex((sample) => sample.revealedShown)
    expect(firstShown).toBeGreaterThanOrEqual(0)
    expect(samples.at(-1)?.revealedShown).toBe(true)
    // The remounted pane is first shown with its saved screen already parsed...
    expect(samples[firstShown]).toMatchObject({ revealedShown: true, revealedInk: true })
    // ...and until it shows, the outgoing workspace stays painted instead of a blank surface.
    expect(samples.slice(0, firstShown).filter((sample) => sample.visibleScreens === 0)).toEqual([])
  } finally {
    await client?.dispose()
    await host.dispose()
    fixture.dispose()
  }
})
