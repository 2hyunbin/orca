import { z } from 'zod'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { quotePosixShell } from '../../src/shared/wsl-login-shell-command'
import {
  probeMotion,
  installWriteProbe,
  readWriteProbe,
  hostSnapshot
} from './helpers/mouse-owner-replay-probes'

test('Linux release 1.4.229: cold restart with a mounted paired client', async ({
  testRepoPath: _testRepoPath
}, testInfo) => {
  test.skip(process.env.ORCA_MOUSE_PROOF_REMOTE !== '1', 'Opt-in isolated Linux release fixture')
  test.skip(process.platform !== 'darwin', 'macOS client against the isolated Linux release')
  test.setTimeout(240_000)
  const root = process.env.ORCA_MOUSE_PROOF_REMOTE_ROOT
  const ssh = process.env.ORCA_MOUSE_PROOF_REMOTE_SSH
  const offerFile = process.env.ORCA_MOUSE_PROOF_OFFER_FILE
  if (!root || !ssh || !offerFile) {
    throw new Error('Missing isolated Linux proof configuration')
  }
  const offer = JSON.parse(readFileSync(offerFile, 'utf8'))
  const control = (action: string) =>
    execFileSync(
      'ssh',
      ['-oBatchMode=yes', ssh, `python3 ${quotePosixShell(`${root}/control.py`)} ${action}`],
      { encoding: 'utf8' }
    )
  const client = await launchPairedElectronClient(offer, testInfo, 'Linux 1.4.229 mouse proof')
  const evidence: Record<string, unknown> = {}
  const call = async (method: string, params: unknown): Promise<unknown> =>
    client.page.evaluate(
      async ({ environmentId, method, params }) => {
        const result = await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method,
          params,
          timeoutMs: 30_000
        })
        if (!result.ok) {
          throw new Error(JSON.stringify(result.error))
        }
        return result.result
      },
      { environmentId: client.environmentId, method, params }
    )
  try {
    const repo = z
      .object({ repo: z.object({ id: z.string() }) })
      .parse(await call('repo.add', { path: `${root}/workspace`, kind: 'folder' }))
    const listed = z
      .object({ worktrees: z.array(z.object({ id: z.string() })) })
      .parse(await call('worktree.list', { repo: `id:${repo.repo.id}` }))
    const worktreeId = listed.worktrees[0].id
    const terminalList = z.object({
      terminals: z.array(z.object({ handle: z.string(), worktreeId: z.string() }))
    })
    const leftovers = terminalList.parse(await call('terminal.list', {}))
    for (const leftover of leftovers.terminals.filter((item) => item.worktreeId === worktreeId)) {
      await call('terminal.close', { terminal: leftover.handle })
    }
    const created = z
      .object({ terminal: z.object({ handle: z.string(), tabId: z.string() }) })
      .parse(
        await call('terminal.create', {
          worktree: `id:${worktreeId}`,
          command: 'bash --noprofile --norc',
          focus: false
        })
      )
    const terminal = created.terminal
    const tabId = toWebTerminalSurfaceTabId(terminal.tabId)
    await client.page.evaluate(
      ({ worktreeId, environmentId }) => {
        const state = window.__store?.getState()
        state?.setActiveView('terminal')
        state?.setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { worktreeId, environmentId: client.environmentId }
    )
    await client.page
      .locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)
      .click({ timeout: 60_000 })
    await expect(client.page.locator('.xterm-screen:visible').first()).toBeVisible()
    await expect
      .poll(() => client.page.evaluate((id) => window.__paneManagers?.has(id) ?? false, tabId))
      .toBe(true)
    await installWriteProbe(client.page, tabId)
    const command = `PS1='ORCA_LINUX_SHELL> '; /usr/local/bin/node ${[`${root}/mouse-mode-owner.cjs`, `${root}/owner.pid`, `${root}/input.jsonl`].map(quotePosixShell).join(' ')}`
    await call('terminal.send', { terminal: terminal.handle, text: command, enter: true })
    await expect
      .poll(() => probeMotion(client.page, tabId), { timeout: 20_000 })
      .toMatchObject({ mode: 'any' })
    evidence.live = await probeMotion(client.page, tabId)
    evidence.hostLiveSnapshot = await hostSnapshot(
      client.page,
      client.environmentId,
      terminal.handle
    )
    await client.page.waitForTimeout(6000)
    evidence.hostBefore = JSON.parse(control('capture'))
    evidence.kill = JSON.parse(control('kill-owner'))
    await expect
      .poll(() => probeMotion(client.page, tabId), { timeout: 15_000 })
      .toMatchObject({ text: expect.stringContaining('ORCA_LINUX_SHELL>') })
    evidence.afterKill = await probeMotion(client.page, tabId)
    await client.page.screenshot({ path: testInfo.outputPath('linux-after-kill.png') })
    evidence.writesBeforeRestart = await readWriteProbe(client.page, true)
    evidence.restart = JSON.parse(control('restart cold'))
    await expect
      .poll(
        async () => {
          try {
            return terminalList.parse(await call('terminal.list', {})).terminals.length
          } catch {
            return 0
          }
        },
        { timeout: 60_000 }
      )
      .toBeGreaterThan(0)
    await client.page.waitForTimeout(5000)
    evidence.afterRestart = await probeMotion(client.page, tabId)
    evidence.writesAfterRestart = await readWriteProbe(client.page)
    evidence.hostAfter = JSON.parse(control('capture'))
    const terminals = terminalList.parse(await call('terminal.list', {}))
    evidence.hostFreshSnapshot = await hostSnapshot(
      client.page,
      client.environmentId,
      terminals.terminals[0].handle
    )
    evidence.hostProcesses = await call('terminal.inspectProcess', {
      terminal: terminals.terminals[0].handle,
      scanChildProcesses: true
    })
    await client.page.screenshot({ path: testInfo.outputPath('linux-after-restart.png') })
    await expect(client.page.locator('.xterm.enable-mouse-events:visible')).toHaveCount(0)
    expect(evidence.afterRestart).toMatchObject({
      mode: 'none',
      focusReporting: false,
      reports: []
    })
    await call('terminal.send', {
      terminal: terminals.terminals[0].handle,
      text: '\u0015reset',
      enter: true
    })
    await expect.poll(() => probeMotion(client.page, tabId)).toMatchObject({ mode: 'none' })
    evidence.afterReset = await probeMotion(client.page, tabId)
    expect(evidence.afterReset).toMatchObject({ mode: 'none', reports: [] })
    await client.page.screenshot({ path: testInfo.outputPath('linux-after-reset.png') })
    await client.page.reload()
    await expect(client.page.locator('.xterm-screen:visible').first()).toBeVisible({
      timeout: 45_000
    })
    await client.page.waitForTimeout(1000)
    evidence.afterReload = await probeMotion(client.page, tabId)
    await client.page.screenshot({ path: testInfo.outputPath('linux-after-reload.png') })
    console.log(
      JSON.stringify({ afterRestart: evidence.afterRestart, afterReload: evidence.afterReload })
    )
  } finally {
    writeFileSync(testInfo.outputPath('observations.json'), JSON.stringify(evidence, null, 2))
    await testInfo.attach('Linux release evidence', {
      body: JSON.stringify(evidence, null, 2),
      contentType: 'application/json'
    })
    await client.dispose()
  }
})
