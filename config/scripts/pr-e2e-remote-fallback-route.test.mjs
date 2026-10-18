import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PR_E2E_SOURCE_ROUTES, selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const MANAGED_SSH_SPEC = /^tests\/e2e\/ssh-orcad-/

function selectsManagedSshLane(file) {
  return selectPrE2eSpecs([file]).some((spec) => MANAGED_SSH_SPEC.test(spec))
}

describe('managed-SSH remote fallback route', () => {
  it('gives every managed-SSH spec a source route', () => {
    const routed = new Set(PR_E2E_SOURCE_ROUTES.flatMap((route) => route.specs))
    const specs = readdirSync(join(projectDir, 'tests/e2e'))
      .filter((name) => /^ssh-orcad-.*\.spec\.ts$/.test(name))
      .map((name) => `tests/e2e/${name}`)
    expect(specs.length).toBeGreaterThan(0)
    expect(specs.filter((spec) => !routed.has(spec))).toEqual([])
  })

  it('starts the lane for remote product sources no hand-kept route names', () => {
    for (const file of [
      // #30130 and #30120 merged with the lane skipped.
      'src/main/ipc/ssh.ts',
      'src/cli/runtime/serve-orcad-launch.ts',
      'src/main/orcad/orcad-entry.ts',
      'src/main/ssh/ssh-connection.ts',
      'src/main/ipc/runtime-environment-status-probe.ts',
      'src/main/ipc/orcad-runtime-lifecycle-handlers.ts',
      'src/shared/protocol-version.ts',
      'src/shared/remote-runtime-client-error-classification.ts',
      // #30047 and #30060: sidebar sleep and project removal.
      'src/renderer/src/components/sidebar/sleep-worktree-flow.ts',
      'src/renderer/src/components/sidebar/ssh-host-remove-resolution.ts',
      'src/renderer/src/store/repos/repo-removal.ts'
    ]) {
      expect(existsSync(join(projectDir, file)), file).toBe(true)
      expect(selectsManagedSshLane(file), file).toBe(true)
    }
  })

  it('leaves unit tests and local-only sources alone', () => {
    for (const file of [
      'src/main/ssh/ssh-connection.test.ts',
      'src/main/ipc/ssh.test.ts',
      'src/main/daemon/daemon-server.ts',
      'src/main/runtime/rpc/methods/accounts.ts',
      'src/renderer/src/components/sidebar/WorktreeCard.tsx',
      'src/renderer/src/store/repos/repo-ordering.ts',
      'docs/STYLEGUIDE.md'
    ]) {
      expect(selectsManagedSshLane(file), file).toBe(false)
    }
  })
})
