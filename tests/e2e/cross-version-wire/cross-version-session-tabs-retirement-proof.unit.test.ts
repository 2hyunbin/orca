import { beforeAll, describe, expect, it } from 'vitest'
import { OldSessionTabsStream } from '../../../src/main/runtime/old-session-tabs-stream'
import type {
  PublishedPane,
  PublishedWorkspaceLayout
} from '../../../src/shared/workspace-layout/workspace-layout-published'
import type { WorkspaceLayoutEvent } from '../../../src/shared/workspace-layout/workspace-layout-stream-frames'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

/**
 * The session-tabs retirement-proof surface, paired across two builds.
 *
 * `cross-version-terminal-wire` covers the terminal binary stream and
 * `cross-version-agent-session-wire` covers `agentSession.*`; neither reaches the
 * session-tabs frame, which is where a paired client learns that a mirrored terminal
 * is gone. This pairs the two halves of that surface across versions:
 *
 *  - the HOST half changed — the old-client stream now derives proofs from the held layout:
 *    a bound pane whose terminal a client holds a handle for, and that leaves the published
 *    layout, rides out as `retiredTerminalSurfaces` on the frame that drops it;
 *  - the CLIENT half did not change, which this asserts by running both builds' ledger and
 *    orphan-recovery proof reader over the same frames rather than by reading the diff.
 *
 * The claim under test is that this is Rule 1, because `retiredTerminalSurfaces` is an
 * existing optional field on an existing path. Rule 3's fourth bullet says "a frame the
 * host ... starts sending, on an existing path" is a wire change even with no codec
 * movement, so the claim is checked against an actual old build rather than accepted.
 *
 * The pre-stack ref is pinned rather than derived: this contract needs a release from
 * before the proof-only frame existed, which is the fallback
 * docs/reference/remote-wire-compatibility.md sanctions for exactly this case.
 */
const PRE_STACK_REF = 'v1.4.199'

const SUITE_TIMEOUT_MS = 180_000

const WORKTREE_ID = 'repo::/worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PARENT_TAB_ID = 'tab'
const PTY_ID = 'pty-left'
const TERMINAL_HANDLE = 'remote:terminal-handle-1'

type Snapshot = {
  worktree: string
  publicationEpoch: string
  snapshotVersion: number
  activeGroupId: null
  activeTabId: string | null
  activeTabType: string | null
  tabs: Record<string, unknown>[]
  retiredTerminalSurfaces?: Record<string, unknown>[]
}

type ProofLedger = {
  appendRetiredTerminalSurfaceProofs: (
    existing: readonly Record<string, unknown>[] | undefined,
    retired: readonly Record<string, unknown>[]
  ) => Record<string, unknown>[]
  dropRetirementProofsForLiveSurfaces: (
    retired: readonly Record<string, unknown>[],
    tabs: readonly Record<string, unknown>[]
  ) => Record<string, unknown>[]
}

type OrphanRecoveryReader = {
  hasTerminalHandleRetirementProof: (
    snapshot: { retiredTerminalSurfaces?: readonly Record<string, unknown>[] },
    surface: { tabId: string; leafId: string; handle: string }
  ) => boolean
}

type OldHostProofPublisher = {
  attachRetirementProofsToSnapshot?: unknown
  retireTerminalSurfacesFromSnapshot: (
    args: Record<string, unknown>
  ) => { snapshot: Snapshot } | null
}

type Build = {
  label: string
  ledger: ProofLedger
  reader: OrphanRecoveryReader
}

type PreStackBuild = Build & { host: OldHostProofPublisher }

/** The surface as the host still holds it, before the close's two halves land. */
function liveSnapshot(): Snapshot {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'renderer',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: `tab::${LEAF_ID}`,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `tab::${LEAF_ID}`,
        parentTabId: PARENT_TAB_ID,
        leafId: LEAF_ID,
        ptyId: PTY_ID,
        title: 'Left',
        isActive: true
      }
    ]
  }
}

/**
 * The renderer-first ordering, which is the one users hit: the close transaction already
 * de-persisted the surface and republished without it, so the PTY exit that follows finds
 * nothing left for persistence to accept.
 */
function snapshotAfterRendererRepublished(): Snapshot {
  return { ...liveSnapshot(), snapshotVersion: 2, tabs: [], activeTabId: null, activeTabType: null }
}

function exitProof(): Record<string, unknown> {
  return {
    parentTabId: PARENT_TAB_ID,
    leafId: LEAF_ID,
    ptyId: PTY_ID,
    terminal: TERMINAL_HANDLE,
    incarnationId: 'inc-1'
  }
}

const LEDGER_PATH = 'src/shared/terminal-retirement-proof-ledger.ts'
const READER_PATH = 'src/renderer/src/runtime/web-session-terminal-orphan-recovery-surface-index.ts'

async function loadStackBuild(): Promise<Build> {
  const [ledger, reader] = await Promise.all([
    import('../../../src/shared/terminal-retirement-proof-ledger'),
    import('../../../src/renderer/src/runtime/web-session-terminal-orphan-recovery-surface-index')
  ])
  return { label: 'stack', ledger, reader }
}

async function loadPreStackBuild(ref: string): Promise<PreStackBuild> {
  const checkout = await materializeReleaseCheckout(ref)
  const [ledger, reader, proof, retirement] = await Promise.all([
    importReleaseCheckoutModule(checkout, LEDGER_PATH),
    importReleaseCheckoutModule(checkout, READER_PATH),
    importReleaseCheckoutModule(
      checkout,
      'src/main/runtime/mobile-session-terminal-retirement-proof.ts'
    ),
    importReleaseCheckoutModule(checkout, 'src/main/runtime/mobile-session-terminal-retirement.ts')
  ])
  return {
    label: ref,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the release checkout is loaded by path, so its exports arrive unknown.
    ledger: ledger as unknown as ProofLedger,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the release checkout is loaded by path, so its exports arrive unknown.
    reader: reader as unknown as OrphanRecoveryReader,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the release checkout is loaded by path; the two modules together are the old host publisher surface.
    host: { ...proof, ...retirement } as unknown as OldHostProofPublisher
  }
}

/**
 * What an old host publishes when the PTY exit lands after the renderer already dropped the
 * surface. `null` means it publishes nothing, which is the stuck-pane defect.
 */
function oldHostPublishesOnExit(build: PreStackBuild, snapshot: Snapshot): Snapshot | null {
  // This build's only route to a proof is the removal helper, and with nothing left to
  // remove it declines to produce a frame.
  return (
    build.host.retireTerminalSurfacesFromSnapshot({
      snapshot,
      ptyId: PTY_ID,
      exactSurfaces: [],
      exactOnly: true,
      retirementProofs: [exitProof()]
    })?.snapshot ?? null
  )
}

function publishedLayout(panes: PublishedPane[]): PublishedWorkspaceLayout {
  return {
    worktreeId: WORKTREE_ID,
    groups: [{ id: 'group', tabIds: ['layout-tab'] }],
    tabs: [
      {
        id: 'layout-tab',
        kind: 'terminal',
        entityId: PARENT_TAB_ID,
        executionHostId: 'local',
        createdAt: 1,
        customTitle: null,
        color: null,
        terminal: { root: null, panes }
      }
    ],
    editorFiles: [],
    browserTabs: []
  }
}

const BOUND_PANE: PublishedPane = { leafId: LEAF_ID, ptyId: PTY_ID, status: 'running' }

/** The proof today's host derives: the pane's identity and the handle a client was issued. */
function layoutProof(): Record<string, unknown> {
  return { parentTabId: PARENT_TAB_ID, leafId: LEAF_ID, ptyId: PTY_ID, terminal: TERMINAL_HANDLE }
}

/**
 * Today's host: the old-client stream over a held layout that showed the bound pane, then
 * republished without it (the pane closed). Returns each frame it serves after `publish`es.
 */
function stackHostFrames(...republished: PublishedPane[][]): Snapshot[] {
  let listener: (event: WorkspaceLayoutEvent) => void = () => {}
  const stream = new OldSessionTabsStream({
    holder: {
      subscribe: (next) => {
        listener = next
        return {
          snapshot: [{ key: WORKTREE_ID, layout: publishedLayout([BOUND_PANE]) }],
          unsubscribe: () => {}
        }
      },
      // The proof stamps are independent of the projected rows, so the model stays unloaded.
      hostIdOf: () => null,
      model: () => null,
      beside: () => null
    },
    contentFacts: () => ({}),
    generatedTitlesEnabled: () => false,
    issuedHandleOf: (ptyId) => (ptyId === PTY_ID ? TERMINAL_HANDLE : null),
    changed: () => {},
    flush: () => {}
  })
  const frames: Snapshot[] = []
  for (const panes of republished) {
    listener({ type: 'workspace', key: WORKTREE_ID, layout: publishedLayout(panes) })
    const frame = stream.snapshot(WORKTREE_ID)
    if (frame) {
      frames.push({ ...frame, activeGroupId: null })
    }
  }
  return frames
}

/** What this build's client retains after the host frame, i.e. the evidence it can act on. */
function clientRetains(build: Build, frame: Snapshot | null): Record<string, unknown>[] {
  if (frame === null) {
    return []
  }
  return build.ledger.dropRetirementProofsForLiveSurfaces(
    build.ledger.appendRetiredTerminalSurfaceProofs(undefined, frame.retiredTerminalSurfaces ?? []),
    frame.tabs
  )
}

let preStack: PreStackBuild
let stack: Build

beforeAll(async () => {
  ;[preStack, stack] = await Promise.all([loadPreStackBuild(PRE_STACK_REF), loadStackBuild()])
}, SUITE_TIMEOUT_MS)

describe('cross-version session-tabs retirement proof', () => {
  it('pairs the stack against a real pre-stack release', () => {
    expect(preStack.label).toBe(PRE_STACK_REF)
    expect(typeof preStack.ledger.dropRetirementProofsForLiveSurfaces).toBe('function')
    expect(typeof preStack.reader.hasTerminalHandleRetirementProof).toBe('function')
    // The anti-vacuous-pass oracle. Two builds that resolved to one module would make every
    // pairing below a same-version run wearing a skew label, and all of them would pass.
    expect(preStack.ledger).not.toBe(stack.ledger)
    expect(preStack.ledger.dropRetirementProofsForLiveSurfaces).not.toBe(
      stack.ledger.dropRetirementProofsForLiveSurfaces
    )
    expect(preStack.reader.hasTerminalHandleRetirementProof).not.toBe(
      stack.reader.hasTerminalHandleRetirementProof
    )
    // Load-bearing for reading the old-host cells: they mean "this release cannot publish a
    // proof-only frame", not "the helper happened to decline".
    expect(preStack.host.attachRetirementProofsToSnapshot).toBeUndefined()
  })

  it('old host against old client publishes no proof on the renderer-first close (the defect)', () => {
    const frame = oldHostPublishesOnExit(preStack, snapshotAfterRendererRepublished())
    expect(frame).toBeNull()
    expect(clientRetains(preStack, frame)).toEqual([])
  })

  it('new host against new client publishes the proof on the frame that drops the pane', () => {
    const [frame] = stackHostFrames([])
    expect(frame?.tabs).toEqual([])
    expect(clientRetains(stack, frame ?? null)).toEqual([layoutProof()])
  })

  it('new host against OLD client: the old ledger and orphan recovery act on the proof', () => {
    const [frame] = stackHostFrames([])
    // The claim under test. An old client that cannot act on this frame would leave the
    // dead pane in its tab bar exactly as before the fix.
    expect(clientRetains(preStack, frame ?? null)).toEqual([layoutProof()])
    expect(
      preStack.reader.hasTerminalHandleRetirementProof(frame ?? {}, {
        tabId: PARENT_TAB_ID,
        leafId: LEAF_ID,
        handle: TERMINAL_HANDLE
      })
    ).toBe(true)
  })

  it('new host bumps snapshotVersion so a version-gating old client accepts the frame', () => {
    const [first, second] = stackHostFrames([BOUND_PANE], [])
    // A client that drops a frame whose version did not advance would silently ignore the
    // proof; this is what makes the proof frame reachable at all.
    expect(first?.retiredTerminalSurfaces).toBeUndefined()
    expect(second?.snapshotVersion).toBeGreaterThan(first?.snapshotVersion ?? Infinity)
    expect(second?.retiredTerminalSurfaces).toEqual([layoutProof()])
  })

  it('old host against NEW client degrades to the two-inventory route, with no crash', () => {
    const frame = oldHostPublishesOnExit(preStack, snapshotAfterRendererRepublished())
    expect(frame).toBeNull()
    expect(clientRetains(stack, frame)).toEqual([])
  })

  it('both builds drop a proof whose surface is published live again, identically', () => {
    const stillLive = liveSnapshot()
    const proofs = [exitProof()]
    // Rule 3 hazard: a proof naming a surface the host is still publishing must not retire
    // it. Both builds must agree, or a skewed pairing retires a live pane.
    expect(preStack.ledger.dropRetirementProofsForLiveSurfaces(proofs, stillLive.tabs)).toEqual([])
    expect(stack.ledger.dropRetirementProofsForLiveSurfaces(proofs, stillLive.tabs)).toEqual([])
  })

  it('a later republish without the pane does not duplicate the proof', () => {
    const [, again] = stackHostFrames([], [])
    expect(again?.retiredTerminalSurfaces).toEqual([layoutProof()])
  })
})
