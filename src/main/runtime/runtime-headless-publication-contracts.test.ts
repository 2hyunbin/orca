import { vi } from 'vitest'
import { registerHeadlessCloseKeepsPublicationEpochTests } from './headless-close-keeps-publication-epoch.spec'
import { registerHeadlessTabOrderStabilityTests } from './headless-tab-order-stability.spec'
import { registerOrcaRuntimeMoveHeadlessMobileSessionTabTests } from './orca-runtime-move-headless-mobile-session-tab.spec'
import { registerOrcaRuntimeHeadlessHydrationRepoGateTests } from './orca-runtime-headless-hydration-repo-gate.spec'

// Tests the rollback path: unit tests default to the shipped ORCA_LAYOUT_OWNER=main build.
vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

registerHeadlessCloseKeepsPublicationEpochTests()
registerHeadlessTabOrderStabilityTests()
registerOrcaRuntimeMoveHeadlessMobileSessionTabTests()
registerOrcaRuntimeHeadlessHydrationRepoGateTests()
