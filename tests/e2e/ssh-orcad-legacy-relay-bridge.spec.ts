/**
 * Upgrading from 1.4.224 keeps the terminals its relay still runs, on a real Docker SSH host:
 *
 * A 1.4.224 relay runs detached with a live shell for this desktop's target, and another one for
 * another desktop's target. The upgraded desktop connects: the host converts to orcad (never
 * refused), the old shell answers typing in its old tab through the bridge, a new terminal opens on
 * orcad, the bridge survives a dropped SSH connection, and when the old shell exits its pane and
 * lease retire. The other desktop's relay and its shell are never touched.
 *
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15, with src/main/ssh/legacy-relay-bridge/.
 */
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { createRestartSession } from './helpers/orca-restart'
import { managedServer, reconnect, serverCall } from './helpers/orcad-convert-flow'
import { seedRelayEraProfile } from './helpers/orcad-upgrade-profile'
import { readPersistedProfileState } from './helpers/persisted-profile-state'
import { toSshExecutionHostId } from '../../src/shared/execution-host'
import { toAppSshPtyId } from '../../src/shared/ssh-pty-id'
import {
  cleanupDockerSshHostTarget,
  DOCKER_SSH_HOST_REMOTE_REPO_PATH,
  execDockerSshHostTargetControlCommand,
  startDockerSshHostTarget,
  type DockerSshHostTarget
} from './helpers/docker-ssh-host-target'
import {
  echoThroughDockerRelay,
  installReleasedRelayOnDockerHost,
  listDockerRelayPtys,
  startDockerRelayWithShell
} from './helpers/legacy-relay-docker-host'
import {
  callEnvironment,
  createPairedHostTerminal,
  openPairedClientTab
} from './helpers/paired-host-terminal'
import { expectTerminalAccessibilityText } from './helpers/terminal-accessibility-tree'
import { focusActiveTerminalInput } from './helpers/terminal'

const TEMPLATE_SOURCE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
const BRIDGE_TIMEOUT_MS = 4 * 60_000

test.skip(
  process.env.ORCA_E2E_ORCAD_CONVERT_HOST !== 'docker' || !TEMPLATE_SOURCE,
  'Set ORCA_E2E_ORCAD_CONVERT_HOST=docker and ORCA_E2E_ORCAD_CONVERT_TEMPLATE'
)

let host: DockerSshHostTarget | null = null

test.afterEach(() => {
  cleanupDockerSshHostTarget(host)
  host = null
})

// The listener is the oldest sshd; every other sshd/sshd-session is a live connection.
const DROP_SSH_CONNECTIONS = `
daemon="$(pgrep -x sshd | sort -n | head -1)"
for pid in $(pgrep -x sshd; pgrep -x sshd-session); do
  [ "$pid" = "$daemon" ] && continue
  kill -9 "$pid" 2>/dev/null
done
true
`

function bridgedPanes(page: Page): Promise<{ ptyId: string; state: string }[]> {
  return page.evaluate(async () => (await window.api.legacyRelayBridge?.listPanes()) ?? [])
}

async function typeIntoActiveTerminal(page: Page, line: string): Promise<void> {
  await focusActiveTerminalInput(page)
  await page.keyboard.type(line, { delay: 20 })
  await page.keyboard.press('Enter')
}

function launchUpgraded(session: ReturnType<typeof createRestartSession>) {
  return session.launch({
    onStderr: (chunk) => {
      if (chunk.includes('[ssh]')) {
        process.stderr.write(chunk)
      }
    }
  })
}

test('terminals a 1.4.224 relay keeps running stay usable in their old tabs after upgrading', async ({
  testRepoPath
}, testInfo: TestInfo) => {
  test.setTimeout(25 * 60_000)
  host = startDockerSshHostTarget(testInfo)
  const targetId = `ssh-bridge-${Date.now()}`
  const relay = await installReleasedRelayOnDockerHost(host, TEMPLATE_SOURCE!)
  const ours = await startDockerRelayWithShell(host, relay, targetId, 'before-upgrade')
  const theirs = await startDockerRelayWithShell(host, relay, 'another-desktop', 'theirs')
  const bridgedPtyId = toAppSshPtyId(targetId, ours.relayPtyId)

  const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE_SOURCE! })
  let app: ElectronApplication | null = null
  try {
    // The first launch only establishes the profile the relay-era rows are written into.
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    await first.page.evaluate((repoPath) => window.api.repos.add({ path: repoPath }), testRepoPath)
    await session.close(app)
    app = null
    const seeded = seedRelayEraProfile(
      session.userDataDir,
      {
        label: `legacy relay bridge E2E ${Date.now()}`,
        host: host.host,
        port: host.port,
        username: 'root',
        identityFile: host.identityFile,
        identitiesOnly: true,
        relayGracePeriodSeconds: 1
      },
      { repoPath: DOCKER_SSH_HOST_REMOTE_REPO_PATH, folderPath: '/tmp' },
      { targetId, relayPtyId: ours.relayPtyId }
    )
    const terminalTabId = seeded.terminalTabId!

    const upgraded = await launchUpgraded(session)
    app = upgraded.app
    const page = upgraded.page
    await waitForSessionReady(page)
    // Mounting the relay-era terminal tab dials the host, as the relay-era pane did.
    await page.evaluate(
      ({ worktreeId, hostId, tabId }) => {
        const state = window.__store!.getState()
        state.setActiveWorktree(worktreeId, hostId)
        state.setActiveTab(tabId)
        state.setActiveTabType('terminal', worktreeId)
      },
      {
        worktreeId: seeded.worktreeId,
        hostId: toSshExecutionHostId(targetId),
        tabId: terminalTabId
      }
    )

    // Never refused: the host converts while its relay terminal is live.
    await expect
      .poll(() => managedServer(page, targetId), { timeout: 8 * 60_000 })
      .toMatchObject({ kind: 'managed' })
    await expect
      .poll(() => bridgedPanes(page), { timeout: BRIDGE_TIMEOUT_MS })
      .toEqual([expect.objectContaining({ ptyId: bridgedPtyId, state: 'live' })])

    const environment = (await page.evaluate(() => window.api.runtimeEnvironments.list())).find(
      (entry) => entry.orcadDeployment?.sshTargetId === targetId
    )
    if (!environment) {
      throw new Error('Converted host is missing from the environment catalog')
    }
    // The old tab moved with the session to the managed server, which lists it for every client.
    await expect
      .poll(
        () =>
          serverCall(page, environment.id, 'session.tabs.list', {
            worktree: `id:${seeded.worktreeId}`
          }),
        { timeout: 60_000 }
      )
      .toContain(terminalTabId)
    // A reconnect hangs the bridge up and finds the old terminal again, as the next launch would.
    await reconnect(page, targetId)
    await expect
      .poll(() => bridgedPanes(page), { timeout: BRIDGE_TIMEOUT_MS })
      .toEqual([expect.objectContaining({ ptyId: bridgedPtyId, state: 'live' })])
    await page.evaluate(
      (hostId) => {
        window.__store!.getState().setGroupBy('none')
        window.__store!.setState({ visibleWorkspaceHostIds: ['local', hostId] })
      },
      `runtime:${environment.id}` as const
    )
    await expect(page.getByText('orcad upgrade folder', { exact: true })).toBeVisible({
      timeout: 120_000
    })
    // The client mirrors the server's tab as `web-terminal-<tab::leaf>`.
    let storeTabId = ''
    await expect
      .poll(
        async () =>
          (storeTabId = await page.evaluate(
            ({ worktreeId, tabId }) =>
              (window.__store!.getState().tabsByWorktree[worktreeId] ?? [])
                .map((tab) => tab.id)
                .find((id) => {
                  const host = id.startsWith('web-terminal-')
                    ? decodeURIComponent(id.slice('web-terminal-'.length))
                    : id
                  return host === tabId || host.startsWith(`${tabId}::`)
                }) ?? '',
            { worktreeId: seeded.worktreeId, tabId: terminalTabId }
          )),
        { timeout: 120_000, message: 'the client never mirrored the relay-era terminal tab' }
      )
      .not.toBe('')
    // The old tab, now under the managed server, shows the old shell's screen and takes input.
    await page.evaluate(
      ({ worktreeId, environmentId, tabId }) => {
        const hostId = `runtime:${environmentId}` as const
        const state = window.__store!.getState()
        state.setGroupBy('none')
        window.__store!.setState({ visibleWorkspaceHostIds: ['local', hostId] })
        state.setActiveView('terminal')
        state.setActiveWorktree(worktreeId, hostId)
        state.setActiveTab(tabId)
        state.setActiveTabType('terminal', worktreeId)
      },
      { worktreeId: seeded.worktreeId, environmentId: environment.id, tabId: storeTabId }
    )
    await page.screenshot({ path: testInfo.outputPath('bridged-tab-activated.png') })
    await expect
      .poll(() => page.evaluate((id) => window.__paneManagers?.has(id) ?? false, storeTabId), {
        timeout: 120_000,
        message: 'the relay-era terminal tab never mounted under the managed server'
      })
      .toBe(true)
    await expectTerminalAccessibilityText(page, storeTabId, 'GOT:before-upgrade', BRIDGE_TIMEOUT_MS)
    await typeIntoActiveTerminal(page, 'after-upgrade')
    await expectTerminalAccessibilityText(page, storeTabId, 'GOT:after-upgrade')
    await page.screenshot({ path: testInfo.outputPath('bridged-terminal.png') })

    // A new terminal opens on orcad.
    const fresh = await createPairedHostTerminal(page, environment.id, seeded.worktreeId, 'bash')
    await openPairedClientTab(page, seeded.worktreeId, fresh.webTabId)
    await callEnvironment(page, environment.id, 'terminal.send', {
      terminal: fresh.terminal,
      text: "printf 'QA_%s\\n' ORCAD_NEW",
      enter: true
    })
    await expectTerminalAccessibilityText(page, fresh.webTabId, 'QA_ORCAD_NEW')
    expect(await listDockerRelayPtys(host, relay, ours.sockPath)).toEqual([ours.relayPtyId])

    // Losing the SSH connection is never the old shell's death: it reattaches and still answers.
    execDockerSshHostTargetControlCommand(host, DROP_SSH_CONNECTIONS)
    await expect
      .poll(() => bridgedPanes(page), { timeout: BRIDGE_TIMEOUT_MS, intervals: [2_000] })
      .toEqual([expect.objectContaining({ ptyId: bridgedPtyId, state: 'live' })])
    await page.evaluate((tabId) => {
      const state = window.__store!.getState()
      state.setActiveView('terminal')
      state.setActiveTab(tabId)
      state.setActiveTabType('terminal', state.activeWorktreeId)
    }, storeTabId)
    await expect
      .poll(
        async () => {
          await typeIntoActiveTerminal(page, 'after-drop')
          return (
            (await page.evaluate((id) => {
              const manager = window.__paneManagers?.get(id)
              const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
              return pane?.serializeAddon?.serialize?.() ?? ''
            }, storeTabId)) ?? ''
          ).includes('GOT:after-drop')
        },
        { timeout: BRIDGE_TIMEOUT_MS, intervals: [5_000] }
      )
      .toBe(true)

    // The old shell exits on its own: its pane and lease retire, and the bridge hangs up.
    await typeIntoActiveTerminal(page, 'quit')
    await expect.poll(() => bridgedPanes(page), { timeout: 60_000 }).toEqual([])
    // A relay left holding nothing may retire on its own grace, which also holds nothing.
    await expect
      .poll(() => listDockerRelayPtys(host!, relay, ours.sockPath).catch(() => []))
      .toEqual([])
    await session.close(app)
    app = null
    const leases = readPersistedProfileState(session.userDataDir).sshRemotePtyLeases
    expect(leases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ptyId: ours.relayPtyId, state: 'terminated' })
      ])
    )

    // Another desktop's relay keeps running its shell, in its directory, untouched.
    expect(await echoThroughDockerRelay(host, relay, theirs, 'still-here')).toContain(
      'GOT:still-here'
    )
    expect(
      execDockerSshHostTargetControlCommand(host, `test -d '${relay.dir}' && echo present`)
    ).toBe('present')
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
  }
})
