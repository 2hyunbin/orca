/**
 * Measurement (bug 19): how long after an `orca serve` restart a paired client's terminal.list and
 * session.tabs.list name the terminals that were open before it. Records, does not judge.
 */
import type { RuntimeTerminalListResult } from '../../src/shared/runtime-terminal-contracts'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-session-contracts'
import { expect, test } from './helpers/orca-app'
import {
  addRepoWorktree,
  cliClient,
  pairedClient,
  startHeadlessOracleHost
} from './helpers/headless-layout-oracle-hosts'

for (const cold of [false, true]) {
  test(`terminals listed after a ${cold ? 'cold' : 'warm'} serve restart`, async () => {
    test.setTimeout(300_000)
    const host = await startHeadlessOracleHost('electron')
    try {
      const cli = cliClient(host)
      const phone = pairedClient(host, 'phone')
      const worktree = `id:${await addRepoWorktree(host, cli)}`
      for (let index = 0; index < 2; index += 1) {
        await cli.call('terminal.create', { worktree })
      }
      const terminals = async () =>
        (
          await phone
            .call<RuntimeTerminalListResult>('terminal.list', { worktree })
            .catch(() => null)
        )?.result.terminals.length ?? -1
      const rows = async () =>
        (
          await phone
            .call<RuntimeMobileSessionTabsResult>('session.tabs.list', { worktree })
            .catch(() => null)
        )?.result.tabs.length ?? -1
      await expect.poll(terminals).toBe(2)
      await host.restart({ cold })
      const started = Date.now()
      const seen: Record<string, number | null> = { terminalList: null, sessionTabs: null }
      const counts: number[] = []
      while (Date.now() - started < 120_000 && Object.values(seen).includes(null)) {
        const listed = await terminals()
        if (counts.at(-1) !== listed) {
          counts.push(listed)
        }
        if (seen.terminalList === null && listed === 2) {
          seen.terminalList = Date.now() - started
        }
        if (seen.sessionTabs === null && (await rows()) === 2) {
          seen.sessionTabs = Date.now() - started
        }
        await new Promise((settle) => setTimeout(settle, 250))
      }
      const cliListed = await cli.call<RuntimeTerminalListResult>('terminal.list', { worktree })
      console.log(`[listing-delay] cli ${JSON.stringify(cliListed.result).slice(0, 1500)}`)
      console.log(
        `[listing-delay] ${process.platform} ${cold ? 'cold' : 'warm'} ${JSON.stringify({ ...seen, counts })}`
      )
    } finally {
      await host.dispose()
    }
  })
}
