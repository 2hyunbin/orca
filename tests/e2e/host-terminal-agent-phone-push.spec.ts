/**
 * #24932: the host that runs a hook-reporting terminal agent pushes its phones when the agent
 * finishes or needs input, with no window open; and a desktop with a window pushes its phone
 * once, not once from main and again from the window.
 */
import { randomUUID } from 'node:crypto'
import { expect, test } from './helpers/orca-app'
import { postClaudeHook, readHookEndpoint } from './helpers/agent-hook-endpoint'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { createDesktopMobilePairingOffer } from './helpers/paired-electron-client'
import { pairMobileClient, type PairedMobileClient } from './helpers/paired-mobile-client'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import type { RuntimeWorktreePsSummary } from '../../src/shared/runtime-worktree-contracts'

type PhoneAlert = { source: string; agentState?: string; worktreeId?: string; title: string }

/** Every notification the host offers this phone, desktop-suppressed ones included. */
async function collectPhoneAlerts(phone: PairedMobileClient): Promise<PhoneAlert[]> {
  const alerts: PhoneAlert[] = []
  let ready = false
  await phone.subscribe<{ type: string } & PhoneAlert>(
    'notifications.subscribe',
    { includeDesktopSuppressed: true },
    {
      onResponse: (response) => {
        if (response.ok && response.result.type === 'ready') {
          ready = true
        } else if (response.ok && response.result.type === 'notification') {
          alerts.push(response.result)
        }
      }
    }
  )
  await expect.poll(() => ready).toBe(true)
  return alerts
}

const agentAlerts = (alerts: PhoneAlert[]): string[] =>
  alerts.filter((alert) => alert.source === 'agent-task-complete').map((a) => a.agentState ?? '')

test('a host with no window pushes its phone when a terminal agent finishes or needs input', async ({
  testRepoPath
}) => {
  test.setTimeout(180_000)
  const host = await launchHeadlessPairedRuntimeHost({ pairingScope: 'mobile' })
  const phone = pairMobileClient(host.offer)
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    const { worktrees } = await phone.call<{ worktrees: RuntimeWorktreePsSummary[] }>(
      'worktree.ps',
      { limit: 1_000 }
    )
    const worktreeId = worktrees.find((row) => row.path === testRepoPath)?.worktreeId ?? ''
    expect(worktreeId, 'the phone lists the serve host workspace').not.toBe('')
    const endpoint = await readHookEndpoint(host.app)
    const pane = { paneKey: `tab-push:${randomUUID()}`, worktreeId }
    const alerts = await collectPhoneAlerts(phone)

    await postClaudeHook(endpoint, pane, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await postClaudeHook(endpoint, pane, { hook_event_name: 'Stop', last_assistant_message: 'ok' })
    await expect.poll(() => agentAlerts(alerts)).toEqual(['done'])

    await postClaudeHook(endpoint, pane, { hook_event_name: 'UserPromptSubmit', prompt: 'more' })
    await postClaudeHook(endpoint, pane, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' }
    })
    await expect.poll(() => agentAlerts(alerts)).toEqual(['done', 'waiting'])

    // A phone holding the workspace open is looking: the news waits until it lets go.
    const session = await phone.subscribe(
      'session.tabs.subscribe',
      { worktree: `id:${worktreeId}` },
      { onResponse: () => {} },
      30_000
    )
    await postClaudeHook(endpoint, pane, { hook_event_name: 'Stop', last_assistant_message: 'ok' })
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(agentAlerts(alerts)).toEqual(['done', 'waiting'])
    // As a locked phone's lingering session ends within the minute.
    session.close()
    await expect.poll(() => agentAlerts(alerts)).toEqual(['done', 'waiting', 'done'])
  } finally {
    phone.dispose()
    await host.dispose()
  }
})

test('a desktop with a window pushes its phone once for a terminal agent’s finish', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(120_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const endpoint = await readHookEndpoint(electronApp)
  const pane = await waitForActivePaneHookDescriptor(orcaPage)
  // Off the workspace, so the window raises its own alert for the finish as well.
  await orcaPage.evaluate(() => window.__store?.setState({ activeView: 'tasks' }))
  const phone = pairMobileClient(await createDesktopMobilePairingOffer(orcaPage))
  try {
    const alerts = await collectPhoneAlerts(phone)
    await postClaudeHook(endpoint, pane, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await postClaudeHook(endpoint, pane, { hook_event_name: 'Stop', last_assistant_message: 'ok' })
    await expect.poll(() => agentAlerts(alerts)).toEqual(['done'])
    // The window's hook lane holds a finish up to 1.5 s for detail; give its copy time to arrive.
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    expect(agentAlerts(alerts)).toEqual(['done'])
  } finally {
    phone.dispose()
  }
})
