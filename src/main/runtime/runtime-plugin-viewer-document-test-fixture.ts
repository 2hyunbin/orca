import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Repo } from '../../shared/repo-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { PluginViewerRuntimeOpen } from '../../shared/plugins/plugin-viewer-runtime-document'
import type { ResolvedRuntimeFileTarget } from './runtime-file-command-target'
import type { RuntimeGitTarget } from './runtime-git-command-target'
import { mergeRuntimeFolderWorkspace } from './runtime-folder-workspace'
import {
  RuntimePluginViewerDocuments,
  type RuntimeViewerTransport
} from './runtime-plugin-viewer-documents'
import { RuntimeSubscriptionRegistry } from './runtime-subscription-registry'

export async function createRuntimeViewerDocumentFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-runtime-viewer-')))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const filePath = join(workspace, 'binary.fixture')
  await writeFile(filePath, Buffer.from([0, 128, 255, 42]))
  const repo: Repo = {
    id: 'folder-repo',
    path: workspace,
    displayName: 'Documents',
    badgeColor: 'blue',
    addedAt: 1,
    kind: 'folder'
  }
  const workspaceId = `${repo.id}::${repo.path}`
  let repos = [repo]
  let target: ResolvedRuntimeFileTarget = {
    worktree: {
      ...mergeRuntimeFolderWorkspace(repo, workspaceId, {}),
      git: { path: workspace, head: '', branch: '', isBare: false, isMainWorktree: true }
    },
    executionHostId: 'local'
  }
  let resolveGate: Promise<void> = Promise.resolve()
  let runtimeId = 'runtime-test'
  const host = {
    getRuntimeId: () => runtimeId,
    requireStore: () => ({
      getRepos: () => repos,
      getProjectGroups: (): ProjectGroup[] => [],
      getFolderWorkspaces: (): FolderWorkspace[] => []
    }),
    async resolveRuntimeFileTarget(selector: string) {
      await resolveGate
      if (selector !== `id:${workspaceId}` && selector !== workspaceId) {
        throw new Error('selector_not_found')
      }
      return target
    },
    async resolveRuntimeGitTarget(selector: string): Promise<RuntimeGitTarget> {
      return host.resolveRuntimeFileTarget(selector)
    }
  }
  const subscriptions = new RuntimeSubscriptionRegistry()
  const documents = new RuntimePluginViewerDocuments(host)
  const input: PluginViewerRuntimeOpen = {
    leaseId: randomUUID(),
    runtimeId,
    filePath,
    owner: {
      executionHostId: 'runtime:client-alias',
      workspaceId,
      clientId: 'desktop',
      tabId: 'tab',
      pluginKey: 'publisher.viewer',
      pluginGeneration: 1
    }
  }
  const transport = (
    connectionId = 'connection-a',
    clientId = 'client-a',
    signal?: AbortSignal
  ): RuntimeViewerTransport => ({
    connectionId,
    clientId,
    signal,
    registerCleanup: (cleanup) =>
      subscriptions.registerOwned(randomUUID(), cleanup, connectionId).releaseIfCurrent
  })
  return {
    root,
    workspace,
    filePath,
    input,
    host,
    documents,
    subscriptions,
    transport,
    setTarget: (value: ResolvedRuntimeFileTarget) => {
      target = value
    },
    getTarget: () => target,
    setResolveGate: (gate: Promise<void>) => {
      resolveGate = gate
    },
    setRuntimeId: (value: string) => {
      runtimeId = value
    },
    setRepos: (value: Repo[]) => {
      repos = value
    }
  }
}
