import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { BrowserSessionProfile } from '../../shared/browser-workspace-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'
import { withDurableRuntimeStore } from './runtime-durable-store-fixture'

const WT = 'repo-1::/home/orca/worktree'
const PROFILE: BrowserSessionProfile = {
  id: 'profile-isolated',
  scope: 'isolated',
  partition: 'persist:orca-browser-session-profile-isolated',
  label: 'Isolated',
  source: null
}

function sessionWithBrowserTab(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    browserTabsByWorktree: {
      [WT]: [
        {
          id: 'browser-tab',
          worktreeId: WT,
          activePageId: 'page-1',
          pageIds: ['page-1'],
          url: 'https://example.test',
          title: 'Example',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1
        }
      ]
    },
    browserPagesByWorkspace: {
      'browser-tab': [
        {
          id: 'page-1',
          workspaceId: 'browser-tab',
          worktreeId: WT,
          url: 'https://example.test',
          title: 'Example',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1
        }
      ]
    },
    unifiedTabs: {
      [WT]: [
        {
          id: 'browser-tab',
          entityId: 'browser-tab',
          groupId: 'group-1',
          worktreeId: WT,
          contentType: 'browser',
          label: 'Example',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    tabGroups: {
      [WT]: [
        { id: 'group-1', worktreeId: WT, activeTabId: 'browser-tab', tabOrder: ['browser-tab'] }
      ]
    },
    activeGroupIdByWorktree: { [WT]: 'group-1' }
  }
}

/** A runtime with no window over a saved session; `saved()` reads what reached disk. */
function windowlessRuntime(session: WorkspaceSessionState) {
  let saved = session
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only the workspace session, repos and settings in this suite.
  const runtime = new OrcaRuntimeService(
    withDurableRuntimeStore({
      getWorkspaceSession: () => saved,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        saved = next
      },
      getRepos: () => [{ id: 'repo-1' }],
      getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
      flushOrThrow: () => {}
    }) as never
  )
  return { runtime, saved: () => saved }
}

describe('browser tab set-profile', () => {
  it('sets the profile with no window, and a reload of the saved session keeps it', async () => {
    const { runtime, saved } = windowlessRuntime(sessionWithBrowserTab())

    runtime.setHeldBrowserTabProfile(undefined, 'page-1', PROFILE)

    expect(runtime.heldWorkspaceLayout(WT)?.browserTabs?.[0]).toMatchObject({
      sessionProfileId: PROFILE.id,
      sessionPartition: PROFILE.partition
    })
    await vi.waitFor(() =>
      expect(saved().browserTabsByWorktree?.[WT]?.[0]).toMatchObject({
        sessionProfileId: PROFILE.id,
        sessionPartition: PROFILE.partition
      })
    )
    const reloaded = windowlessRuntime(saved()).runtime
    expect(reloaded.heldWorkspaceLayout(WT)?.browserTabs?.[0]).toMatchObject({
      sessionProfileId: PROFILE.id,
      sessionPartition: PROFILE.partition
    })
  })

  it('refuses a page no held tab shows', () => {
    const { runtime } = windowlessRuntime(sessionWithBrowserTab())
    expect(() => runtime.setHeldBrowserTabProfile(WT, 'page-missing', PROFILE)).toThrow(
      'Browser tab page-missing not found'
    )
  })
})
