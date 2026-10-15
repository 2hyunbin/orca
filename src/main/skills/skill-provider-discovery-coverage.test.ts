import { join, posix, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SKILL_INSTALL_PROVIDERS } from '../../shared/skill-install-providers'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { buildSkillDiscoverySources } from './skill-discovery-sources'
import { resolveEnvironmentSkillProviderRoots } from './skill-provider-runtime-roots'

const HOME = '/home/test'
const WORKSPACE = '/workspace/current'

function discover(providerRootOverrides = {}) {
  return buildSkillDiscoverySources({
    homeDir: HOME,
    cwd: WORKSPACE,
    pathApi: posix,
    providerRootOverrides
  })
}

describe('skill install provider table drives discovery', () => {
  it('uses only Orca agent detection ids', () => {
    const unknown = SKILL_INSTALL_PROVIDERS.map((provider) => provider.id).filter(
      (id) => !(id in TUI_AGENT_CONFIG)
    )
    expect(unknown).toEqual([])
  })

  it('lists every provider install folder at each scope it has one', () => {
    const sources = discover()
    for (const provider of SKILL_INSTALL_PROVIDERS) {
      const globalSegments = provider.globalSegments ?? provider.globalDiscoverySegments
      if (globalSegments) {
        expect(sources, provider.id).toContainEqual(
          expect.objectContaining({
            path: posix.join(HOME, ...globalSegments),
            sourceKind: 'home',
            owner: provider.id
          })
        )
      }
      if (provider.workspaceSegments) {
        expect(sources, provider.id).toContainEqual(
          expect.objectContaining({
            path: posix.join(WORKSPACE, ...provider.workspaceSegments),
            sourceKind: 'repo',
            owner: provider.id
          })
        )
      }
    }
    // Agents with a null scope read the canonical root, which is always listed.
    expect(sources.map((source) => source.path)).toEqual(
      expect.arrayContaining([
        posix.join(HOME, '.agents', 'skills'),
        posix.join(WORKSPACE, '.agents', 'skills')
      ])
    )
  })

  it('relocates a provider home named by its env var for install and discovery alike', () => {
    for (const provider of SKILL_INSTALL_PROVIDERS) {
      if (!provider.homeEnv) {
        continue
      }
      const relocated = resolve('/srv', provider.id)
      const overrides = resolveEnvironmentSkillProviderRoots({ [provider.homeEnv]: relocated })
      expect(overrides).toEqual({ [provider.id]: join(relocated, 'skills') })
      expect(
        discover(overrides).find(
          (source) => source.sourceKind === 'home' && source.owner === provider.id
        )?.path
      ).toBe(overrides[provider.id])
    }
  })

  it('keeps the scan order discovery had before the table drove it', () => {
    // Why: the first root scanned names a skill reached through a symlink from two roots.
    const homeIds = discover()
      .filter((source) => source.sourceKind !== 'repo')
      .map((source) => source.id)
    expect(homeIds.slice(0, 12)).toEqual([
      'home-codex',
      'home-agents',
      'home-claude',
      'codex-plugin-cache',
      'home-grok',
      'home-opencode',
      'home-pi',
      'home-omp',
      'home-hermes',
      'home-prime-agent',
      'home-gemini',
      'home-antigravity'
    ])
    expect(homeIds.slice(12)).toEqual(
      SKILL_INSTALL_PROVIDERS.filter(
        (provider) =>
          (provider.globalSegments || provider.globalDiscoverySegments) &&
          !['claude', 'grok', 'gemini'].includes(provider.id)
      ).map((provider) => `home-${provider.id}`)
    )
  })
})
