import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { classifyE2eJobs, selectGeneralE2eSpecs } from './ci-e2e-job-selection.mjs'
import {
  PR_E2E_SOURCE_ROUTES,
  selectPrE2eSpecs,
  shouldRunReusablePrE2e
} from './pr-e2e-source-routing.mjs'

const projectDir = resolve(import.meta.dirname, '../..')

const ORACLE_ROUTE = PR_E2E_SOURCE_ROUTES.find((route) => route.id === 'workspace-layout.oracle')
const TAB_STORE_ROUTE = PR_E2E_SOURCE_ROUTES.find(
  (route) => route.id === 'workspace-layout.oracle-tab-store'
)

/** One product file per layout writer family; each alone must run the oracle. */
const LAYOUT_AUTHORITIES = [
  'src/shared/workspace-layout/workspace-layout-pane-commands.ts',
  'src/main/persistence/terminal-topology/terminal-topology-commit.ts',
  'src/main/persistence/restoring-sessions/session-owner-fields.ts',
  'src/main/persistence/loading-store/pty-binding-persistence.ts',
  'src/main/runtime/terminal/launch/terminal-split.ts',
  'src/main/runtime/session-tabs/headless-tab-group-moves.ts',
  'src/main/runtime/orca-runtime-persist-headless-terminal-title.ts',
  'src/main/runtime/session-tabs/mobile-session-hydration.ts',
  'src/main/runtime/session-tabs/mobile-session-preservation.ts',
  'src/main/runtime/session-tabs/mobile-session-reconciliation.ts',
  'src/main/runtime/terminal/launch/terminal-create.ts',
  'src/main/runtime/terminal/launch/terminal-created-surface.ts',
  'src/main/runtime/terminal/launch/terminal-desktop-create.ts',
  'src/main/runtime/terminal/launch/terminal-caller-spawn-scope.ts',
  'src/main/runtime/terminal/output/terminal-derived-agent-facts.ts',
  'src/main/runtime/terminal/output/terminal-osc-metadata.ts',
  'src/renderer/src/runtime/mobile-session-tab-close.ts',
  'src/renderer/src/runtime/runtime-layout-client.ts',
  'tests/e2e/workspace-layout-oracle-known-on-main.ts',
  'tests/e2e/helpers/workspace-layout-oracle-compare.ts'
]

describe('workspace layout oracle PR E2E routing', () => {
  it('routes each layout authority on its own', () => {
    expect(ORACLE_ROUTE, 'the oracle route was renamed or removed').toBeDefined()
    for (const file of LAYOUT_AUTHORITIES) {
      expect(selectPrE2eSpecs([file]), file).toEqual(ORACLE_ROUTE.specs.toSorted())
      expect(shouldRunReusablePrE2e([file]), file).toBe(true)
    }
  })

  it.each([
    ['hydrate-headless-mobile-session-tabs-from-workspace-session', 'hydration'],
    ['merge-preserved-headless-mobile-session-tabs', 'preservation'],
    ['sync-mobile-session-tabs', 'reconciliation']
  ])('preserves oracle routing when %s moves to a session owner', (original, owner) => {
    const source = `src/main/runtime/orca-runtime-${original}.ts`
    const destination = `src/main/runtime/session-tabs/mobile-session-${owner}.ts`
    expect(existsSync(join(projectDir, source)), source).toBe(true)
    expect(existsSync(join(projectDir, destination)), destination).toBe(true)
    expect(selectPrE2eSpecs([source]), source).toEqual(ORACLE_ROUTE.specs.toSorted())
    expect(selectPrE2eSpecs([destination]), destination).toEqual(ORACLE_ROUTE.specs.toSorted())
    expect(shouldRunReusablePrE2e([destination]), destination).toBe(true)
  })

  it('runs the window and headless oracles, not the SSH lane, for the tab store', () => {
    for (const file of [
      'src/renderer/src/store/slices/tabs.ts',
      'src/renderer/src/store/slices/tabs/tabs-move-actions.ts'
    ]) {
      expect(selectPrE2eSpecs([file]), file).toEqual(TAB_STORE_ROUTE.specs.toSorted())
      expect(existsSync(join(projectDir, file)), file).toBe(true)
    }
  })

  it('sends each oracle spec to the job that can run it', () => {
    const specs = ORACLE_ROUTE.specs
    // Window spec runs in the general shards; headless runs in its dedicated job.
    expect(selectGeneralE2eSpecs(specs)).toEqual(['tests/e2e/workspace-layout-oracle.spec.ts'])
    expect(classifyE2eJobs(JSON.stringify(specs))).toEqual({
      e2e_run_changed: true,
      e2e_needs_build: true
    })
  })

  it('keeps every routed spec and authority a real file', () => {
    for (const file of [...ORACLE_ROUTE.specs, ...LAYOUT_AUTHORITIES]) {
      expect(existsSync(join(projectDir, file)), file).toBe(true)
    }
  })

  it('leaves tests, fixtures and unrelated runtime modules alone', () => {
    for (const file of [
      'src/main/persistence/terminal-topology/terminal-topology-commit.test.ts',
      'src/main/persistence/terminal-topology/terminal-leaf-move-fixture.ts',
      'src/main/runtime/orca-runtime-tests/mobile-session-tabs-part-03.spec.ts',
      'src/main/runtime/runtime-durable-store-fixture.ts',
      'src/main/runtime/orchestration/db/worker-terminal/worker-terminal-store.ts',
      'src/main/runtime/rpc/methods/terminal/terminal-create.ts',
      'src/main/runtime/runtime-rpc-database.ts',
      'src/main/runtime/orca-runtime-files.ts',
      'src/main/runtime/session-tabs/mobile-session-hydration.test.ts',
      'src/main/runtime/session-tabs/mobile-session-preservation.spec.ts',
      'src/main/runtime/session-tabs/mobile-session-reconciliation-fixture.ts',
      'src/main/runtime/session-tabs/mobile-session-browser-group-projection.ts',
      'src/main/runtime/terminal/output/terminal-derived-agent-facts.test.ts',
      'src/main/runtime/terminal/output/terminal-osc-metadata.spec.ts',
      'src/main/runtime/terminal/output/terminal-osc-metadata-fixture.ts',
      'src/main/runtime/terminal/output/pty-output-ingestion.ts',
      'src/main/runtime/terminal/layout/terminal-layout-application.ts',
      'src/main/runtime/browser/browser-commands.ts',
      'src/main/runtime/terminal/launch/terminal-create-identity.ts',
      'src/main/runtime/terminal/launch/mobile-terminal-startup.ts',
      'src/main/runtime/terminal/launch/terminal-execution-context.ts',
      'src/main/runtime/terminal/launch/terminal-caller-spawn-scope.test.ts',
      'src/main/runtime/terminal/launch/terminal-caller-spawn-scope.spec.ts',
      'src/main/runtime/terminal/launch/terminal-caller-spawn-scope-fixture.ts',
      'src/main/runtime/terminal/launch/terminal-caller-spawn-scope-neighbor.ts',
      'src/renderer/src/runtime/sync-runtime-graph.ts',
      'src/renderer/src/runtime/remote-runtime-terminal-multiplexer.ts',
      'src/renderer/src/runtime/web-session-tabs-sync-test-harness.ts',
      'tests/e2e/workspace-layout-oracle-latency.spec.ts'
    ]) {
      expect(ORACLE_ROUTE.matches(file) || TAB_STORE_ROUTE.matches(file), file).toBe(false)
    }
  })
})
