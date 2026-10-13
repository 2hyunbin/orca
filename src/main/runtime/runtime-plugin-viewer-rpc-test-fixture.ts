import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../persistence'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { RemoteRuntimeRequestConnection } from '../../shared/remote-runtime-request-connection'
import { parsePairingCode } from '../../shared/pairing'
import { PLUGIN_VIEWER_RUNTIME_DOCUMENT_CAPABILITY } from '../../shared/plugins/plugin-viewer-runtime-capability'
import type { PluginViewerRuntimeOpen } from '../../shared/plugins/plugin-viewer-runtime-document'

export async function runtimeViewerRpcFixture(
  cleanups: (() => Promise<void> | void)[],
  scope: 'runtime' | 'mobile' = 'runtime',
  folderWorkspace = false
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orv-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'Documents')
  await mkdir(workspace)
  const filePath = join(workspace, 'binary.fixture')
  await writeFile(filePath, Buffer.from([0, 128, 255, 42]))
  const repo = {
    id: 'documents',
    path: workspace,
    displayName: 'Documents',
    badgeColor: 'blue',
    addedAt: 1,
    kind: 'folder'
  }
  const store = new Store({
    dataFile: join(root, 'orca-data.json'),
    serializedState: JSON.stringify(
      folderWorkspace
        ? {
            repos: [],
            projectGroups: [
              {
                id: 'group',
                name: 'Documents',
                parentPath: root,
                parentGroupId: null,
                createdFrom: 'manual',
                tabOrder: 0,
                isCollapsed: false,
                color: null,
                createdAt: 1,
                updatedAt: 1
              }
            ],
            folderWorkspaces: [
              {
                id: 'folder',
                projectGroupId: 'group',
                name: 'Documents',
                folderPath: workspace,
                executionHostId: 'local',
                linkedTask: null,
                comment: '',
                isArchived: false,
                isUnread: false,
                isPinned: false,
                sortOrder: 0,
                lastActivityAt: 0,
                createdAt: 1,
                updatedAt: 1
              }
            ]
          }
        : { repos: [repo] }
    )
  })
  const runtime = new OrcaRuntimeService(store)
  const rpc = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: root,
    enableWebSocket: true,
    wsPort: 0
  })
  cleanups.push(() => rpc.stop())
  await rpc.start()
  const offer = rpc.createPairingOffer({ name: 'viewer-document', scope })
  if (!offer.available) {
    throw new Error('pairing unavailable')
  }
  const pairing = parsePairingCode(offer.pairingUrl)
  if (!pairing) {
    throw new Error('invalid pairing')
  }
  const connect = (
    capabilities: readonly string[] = [PLUGIN_VIEWER_RUNTIME_DOCUMENT_CAPABILITY]
  ) => {
    const connection = new RemoteRuntimeRequestConnection(
      pairedRuntimeConnectionFromOffer(pairing),
      capabilities
    )
    cleanups.push(() => connection.close())
    return connection
  }
  const input: PluginViewerRuntimeOpen = {
    runtimeId: runtime.getRuntimeId(),
    leaseId: randomUUID(),
    filePath,
    owner: {
      executionHostId: 'runtime:client-env',
      workspaceId: folderWorkspace ? 'folder:folder' : `${repo.id}::${workspace}`,
      clientId: 'desktop',
      tabId: 'tab',
      pluginKey: 'publisher.viewer',
      pluginGeneration: 1
    }
  }
  return { root, workspace, filePath, input, runtime, connect, pairing, rpc, store }
}
