import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { publishHeadlessRuntimeGraph } from '../headless-runtime-graph'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'

const WINDOW_ID = 1
const GIT_ID = 'repo-1::/work/feature'

function scope(overrides: Partial<AgentSessionExecutionLocation> = {}) {
  return {
    executionHostId: 'local' as const,
    wslDistro: null,
    workspaceId: GIT_ID,
    workspaceKind: 'git-worktree' as const,
    ...overrides
  }
}

function publish(
  runtime: OrcaRuntimeService,
  rendererGeneration: string,
  notificationHiddenWorkspaceKeys?: string[]
): void {
  runtime.syncWindowGraph(WINDOW_ID, {
    tabs: [],
    leaves: [],
    rendererGeneration,
    ...(notificationHiddenWorkspaceKeys ? { notificationHiddenWorkspaceKeys } : {})
  })
}

describe("the window graph's notification-hidden workspaces", () => {
  it('hides nothing before a window publishes, and when its graph carries no set', () => {
    const runtime = new OrcaRuntimeService()
    expect(runtime.isNotificationHiddenWorkspace(scope())).toBe(false)
    publish(runtime, 'renderer:gen-1')
    expect(runtime.isNotificationHiddenWorkspace(scope())).toBe(false)
  })

  it('looks up git, SSH and folder chats by the keys the renderer publishes', () => {
    const runtime = new OrcaRuntimeService()
    publish(runtime, 'renderer:gen-1', [GIT_ID, 'repo-2::/remote/feature', 'folder:notes'])
    expect(runtime.isNotificationHiddenWorkspace(scope())).toBe(true)
    expect(
      runtime.isNotificationHiddenWorkspace(
        scope({ executionHostId: 'ssh:box', workspaceId: 'repo-2::/remote/feature' })
      )
    ).toBe(true)
    expect(
      runtime.isNotificationHiddenWorkspace(
        scope({ workspaceId: 'notes', workspaceKind: 'folder' })
      )
    ).toBe(true)
    // A folder is never matched by its bare id, nor a worktree by a folder key.
    expect(runtime.isNotificationHiddenWorkspace(scope({ workspaceId: 'notes' }))).toBe(false)
    expect(
      runtime.isNotificationHiddenWorkspace(
        scope({ workspaceId: 'repo-1::/work/other', workspaceKind: 'git-worktree' })
      )
    ).toBe(false)
  })

  it('keeps the last set across a renderer reload until the new generation publishes its own', () => {
    const runtime = new OrcaRuntimeService()
    publish(runtime, 'renderer:gen-1', [GIT_ID])
    runtime.markRendererReloading(WINDOW_ID)
    expect(runtime.isNotificationHiddenWorkspace(scope())).toBe(true)
    publish(runtime, 'renderer:gen-2')
    expect(runtime.isNotificationHiddenWorkspace(scope())).toBe(true)
    publish(runtime, 'renderer:gen-2', [])
    expect(runtime.isNotificationHiddenWorkspace(scope())).toBe(false)
  })

  it('never sets one on a headless server, which has no renderer', () => {
    const runtime = new OrcaRuntimeService()
    publishHeadlessRuntimeGraph(runtime)
    expect(runtime.isNotificationHiddenWorkspace(scope())).toBe(false)
  })
})
