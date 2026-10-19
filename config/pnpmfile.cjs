'use strict'

// Self-contained on purpose: scratch installs copy this file alone, beside the lockfile that pins its checksum.
const GLOBAL_VIRTUAL_STORE_ENV = 'ORCA_PNPM_GLOBAL_VIRTUAL_STORE'
// CI-only: the dependency-isolation job installs with the store on so undeclared deps fail PRs.
const FORCE_IN_CI_ENV = 'ORCA_PNPM_FORCE_GLOBAL_VIRTUAL_STORE_IN_CI'

function isCi(env) {
  return (Boolean(env.CI) && env.CI !== 'false' && env.CI !== '0') || env.GITHUB_ACTIONS === 'true'
}

/**
 * Whether this install uses pnpm's global virtual store: one store slot per package version,
 * shared by every worktree, instead of a full node_modules each.
 *
 * Off under CI, which packages from, caches, and verifies a project-local node_modules, unless
 * `ORCA_PNPM_FORCE_GLOBAL_VIRTUAL_STORE_IN_CI=1` (the dependency-isolation job).
 * Windows needs `ORCA_PNPM_GLOBAL_VIRTUAL_STORE=1` because its store links are true symlinks,
 * unverified for users without admin or Developer Mode; `=0` opts out anywhere else.
 */
function usesGlobalVirtualStore({ env = process.env, platform = process.platform } = {}) {
  if (isCi(env)) {
    return env[FORCE_IN_CI_ENV] === '1'
  }
  const choice = env[GLOBAL_VIRTUAL_STORE_ENV]
  if (choice === '0' || choice === '1') {
    return choice === '1'
  }
  return platform !== 'win32'
}

module.exports = {
  hooks: {
    updateConfig(config) {
      // Why here and not pnpm-workspace.yaml: pnpm exec derives NODE_PATH from the file setting,
      // which put the root node_modules on every CI child's NODE_PATH even with the store off.
      config.enableGlobalVirtualStore = usesGlobalVirtualStore()
      return config
    }
  },
  FORCE_IN_CI_ENV,
  GLOBAL_VIRTUAL_STORE_ENV,
  usesGlobalVirtualStore
}
