// #33424: two desktops paired to each other. Each server republishes what it mirrors, so B echoes A's
// own workspace back to A; A must not adopt that echo or its file reads and closes go to B.
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { createRuntimeDesktopPairingOffer } from './helpers/paired-electron-client'

async function pairAndSelect(page: Page, pairingUrl: string, name: string): Promise<string> {
  return page.evaluate(
    async ({ name, pairingUrl }) => {
      const store = window.__store!
      const result = await window.api.runtimeEnvironments.verifyAndAddFromPairingCode({
        name,
        pairingCode: pairingUrl,
        allowLoopback: true
      })
      if (!result.ok) {
        throw new Error(`Pairing ${name} failed: ${JSON.stringify(result)}`)
      }
      const id = result.environment.id
      store.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
      if (!(await store.getState().refreshRuntimeEnvironmentStatus(id))) {
        throw new Error(`Could not reach ${name}`)
      }
      if (!(await store.getState().setActiveRuntimeEnvironmentPreference(id))) {
        throw new Error(`Could not select ${name}`)
      }
      return id
    },
    { name, pairingUrl }
  )
}

function openFilesIn(page: Page, worktreeId: string) {
  return page.evaluate(
    (id) =>
      window
        .__store!.getState()
        .openFiles.filter((file) => file.worktreeId === id)
        .map((file) => ({
          relativePath: file.relativePath,
          env: file.runtimeEnvironmentId ?? null
        })),
    worktreeId
  )
}

test('a desktop ignores its own workspace echoed back by a server it serves', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(240_000)
  const hubBSession = createRestartSession(testInfo)
  const hubB = await hubBSession.launch()
  try {
    await hubB.page.waitForFunction(
      () => window.__store?.getState().workspaceSessionReady === true,
      null,
      { timeout: 60_000 }
    )
    const worktree = await orcaPage.evaluate(() => {
      const listed = window.__store!.getState().allWorktrees()[0]
      return listed ? { id: listed.id, path: listed.path } : null
    })
    expect(worktree).not.toBeNull()
    const { id: worktreeId, path: worktreePath } = worktree!

    const desktopBOnA = await pairAndSelect(
      orcaPage,
      (await createRuntimeDesktopPairingOffer(hubB.page)).pairingUrl,
      'Desktop B'
    )
    const desktopAOnB = await pairAndSelect(
      hubB.page,
      (await createRuntimeDesktopPairingOffer(orcaPage)).pairingUrl,
      'Desktop A'
    )
    await expect
      .poll(
        () =>
          hubB.page.evaluate(
            (id) =>
              window
                .__store!.getState()
                .allWorktrees()
                .some((entry) => entry.id === id),
            worktreeId
          ),
        {
          timeout: 60_000,
          message: 'Desktop B never listed desktop A’s workspace'
        }
      )
      .toBe(true)

    await hubB.page.evaluate(
      ({ environmentId, worktreeId, worktreePath }) => {
        const state = window.__store!.getState()
        state.setActiveView('terminal')
        state.setActiveWorktree(worktreeId, `runtime:${environmentId}`)
        state.openFile({
          filePath: `${worktreePath}/README.md`,
          relativePath: 'README.md',
          worktreeId,
          runtimeEnvironmentId: environmentId,
          language: 'markdown',
          mode: 'edit'
        })
      },
      { environmentId: desktopAOnB, worktreeId, worktreePath }
    )
    await expect
      .poll(() => openFilesIn(hubB.page, worktreeId), { timeout: 30_000 })
      .toEqual([{ relativePath: 'README.md', env: desktopAOnB }])

    // B's server now publishes its mirror of A's workspace, which A subscribes to.
    await expect
      .poll(
        () =>
          orcaPage.evaluate(
            async ({ selector, worktreeId }) => {
              const response = await window.api.runtimeEnvironments.call({
                selector,
                method: 'session.tabs.listAll'
              })
              const result: unknown = response.ok ? response.result : null
              const snapshots =
                result && typeof result === 'object' && 'snapshots' in result
                  ? result.snapshots
                  : null
              if (!Array.isArray(snapshots)) {
                return false
              }
              return snapshots.some(
                (snapshot: { worktree: string; tabs: { type: string }[] }) =>
                  snapshot.worktree === worktreeId &&
                  snapshot.tabs.some((tab) => tab.type === 'markdown')
              )
            },
            { selector: desktopBOnA, worktreeId }
          ),
        {
          timeout: 30_000,
          message: 'Desktop B never published its mirror of A’s workspace'
        }
      )
      .toBe(true)
    // ast-grep-ignore: test-no-real-time-wait -- proving absence: let A's live subscription deliver B's frame
    await orcaPage.waitForTimeout(5_000)
    expect(await openFilesIn(orcaPage, worktreeId)).toEqual([])
    expect(await openFilesIn(hubB.page, worktreeId)).toEqual([
      { relativePath: 'README.md', env: desktopAOnB }
    ])
  } finally {
    await hubBSession.close(hubB.app)
    await hubBSession.dispose()
  }
})
