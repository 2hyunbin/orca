import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), isPackaged: false },
  BrowserWindow: { fromId: () => null },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: () => null }
}))

const cases = [
  ['resolveRuntimeGitTarget', 'reject', 'runtime_unavailable'],
  ['resolveRuntimeFileTarget', 'reject', 'runtime_unavailable'],
  ['resolveKnownWorkspaceFileTarget', 'promise', null],
  ['readMobileMarkdownTab', 'reject', 'tab_not_found'],
  ['saveMobileMarkdownTab', 'reject', 'tab_not_found'],
  ['resolveMobileMarkdownWorktreeId', 'reject', 'tab_not_found'],
  ['invalidateSshWorktreeScanCache', 'sync', undefined],
  ['notifyWorktreesChangedForRemoteClients', 'sync', undefined],
  ['publishWorktreeRemovalChange', 'sync', undefined],
  ['notifyWorktreeCatalogChangedForRemoteClients', 'sync', undefined],
  ['notifyReposChangedForRemoteClients', 'sync', undefined],
  ['notifyActivateWorktree', 'sync', undefined],
  ['notifyClientsActivateWorktree', 'sync', undefined],
  ['onMobileSessionTabsChanged', 'subscription', undefined]
] as const

type ProbeName = (typeof cases)[number][0]
let probeName: ProbeName = 'notifyReposChangedForRemoteClients'
let result: unknown
let synchronousFailure: unknown
let unsubscribe: (() => void) | undefined
let seamCalls = 0

class ConstructorProbe extends OrcaRuntimeService {
  protected override get canonicalFetchKeyCache() {
    seamCalls += 1
    try {
      result = this.inspectDuringConstruction(probeName)
    } catch (error) {
      synchronousFailure = error
    }
    return super.canonicalFetchKeyCache
  }

  listenerCount(): number {
    return this.mobileSessionTabListeners.size
  }

  private inspectDuringConstruction(name: ProbeName): unknown {
    switch (name) {
      case 'resolveRuntimeGitTarget':
        return this.resolveRuntimeGitTarget('id:folder-proof')
      case 'resolveRuntimeFileTarget':
        return this.resolveRuntimeFileTarget('id:folder-proof')
      case 'resolveKnownWorkspaceFileTarget':
        return this.resolveKnownWorkspaceFileTarget(join(tmpdir(), 'file-proof'), 'local')
      case 'readMobileMarkdownTab':
        return this.readMobileMarkdownTab('id:folder-proof', 'tab-proof')
      case 'saveMobileMarkdownTab':
        return this.saveMobileMarkdownTab(
          'id:folder-proof',
          'tab-proof',
          'version-proof',
          'content'
        )
      case 'resolveMobileMarkdownWorktreeId':
        return this.resolveMobileMarkdownWorktreeId('id:folder-proof', 'tab-proof')
      case 'invalidateSshWorktreeScanCache':
        return this.invalidateSshWorktreeScanCache('host-proof')
      case 'notifyWorktreesChangedForRemoteClients':
        return this.notifyWorktreesChangedForRemoteClients('repo-proof')
      case 'publishWorktreeRemovalChange':
        return this.publishWorktreeRemovalChange('repo-proof')
      case 'notifyWorktreeCatalogChangedForRemoteClients':
        return this.notifyWorktreeCatalogChangedForRemoteClients('repo-proof')
      case 'notifyReposChangedForRemoteClients':
        return this.notifyReposChangedForRemoteClients()
      case 'notifyActivateWorktree':
        return this.notifyActivateWorktree('repo-proof', 'folder-proof')
      case 'notifyClientsActivateWorktree':
        return this.notifyClientsActivateWorktree('repo-proof', 'folder-proof')
      case 'onMobileSessionTabsChanged':
        unsubscribe = this.onMobileSessionTabsChanged(() => undefined, 'constructor-proof')
        return unsubscribe
    }
  }
}

describe('workspace file notifications during runtime construction', () => {
  it.each(cases)('preserves %s before later fields initialize', async (name, phase, expected) => {
    probeName = name
    result = undefined
    synchronousFailure = undefined
    seamCalls = 0
    const runtime = new ConstructorProbe(null)
    expect(seamCalls).toBe(1)
    expect(synchronousFailure).toBeUndefined()
    if (phase === 'sync') {
      expect(result).not.toBeInstanceOf(Promise)
      expect(result).toEqual(expected)
      return
    }
    if (phase === 'subscription') {
      expect(typeof result).toBe('function')
      expect(runtime.listenerCount()).toBe(1)
      unsubscribe?.()
      expect(runtime.listenerCount()).toBe(0)
      return
    }
    expect(result).toBeInstanceOf(Promise)
    await (phase === 'reject'
      ? expect(result).rejects.toThrow(expected)
      : expect(result).resolves.toEqual(expected))
  })
})
