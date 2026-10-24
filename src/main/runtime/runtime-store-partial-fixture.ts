import type { RuntimeStore } from './runtime-store-contract'

type RuntimeSettings = ReturnType<RuntimeStore['getSettings']>

export type PartialRuntimeStore = Partial<Omit<RuntimeStore, 'getSettings'>> & {
  getSettings?: () => Partial<RuntimeSettings>
}

function unstubbedWrite(member: string): () => never {
  return () => {
    throw new Error(`runtime store fake does not stub ${member}`)
  }
}

/** A runtime store fake: empty reads and refused writes beyond the members a test supplies. */
export function partialRuntimeStore(overrides: PartialRuntimeStore = {}): RuntimeStore {
  const { getSettings, ...members } = overrides
  return {
    getRepos: () => [],
    getRepo: () => undefined,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getGitHubCache: () => ({ pr: {}, issue: {} }),
    addRepo: unstubbedWrite('addRepo'),
    updateRepo: unstubbedWrite('updateRepo'),
    setWorktreeMeta: unstubbedWrite('setWorktreeMeta'),
    removeWorktreeMeta: unstubbedWrite('removeWorktreeMeta'),
    ...members,
    getSettings: () => ({
      workspaceDir: '',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: '',
      ...getSettings?.()
    })
  }
}
