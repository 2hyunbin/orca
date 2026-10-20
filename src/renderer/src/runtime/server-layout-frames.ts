// A paired server whose main takes layout intents (`layout.intents.v1`) draws its workspaces in
// this window from its layout stream instead of the session.tabs mirror (design H5). One source per
// workspace at a time: the mirror stops writing a workspace's layout as the stream's snapshot comes
// in, and gets it back, with a fresh snapshot, when the stream stops. session.tabs keeps flowing for
// terminal handles and statuses either way.

import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import { LAYOUT_INTENTS_RUNTIME_CAPABILITY } from '../../../shared/workspace-layout/layout-intents-capability'
import { getReachableRuntimeSessionMirrorTargets } from '@/lib/runtime-session-mirror-targets'
import { selectRuntimeSessionMirrorTargetInputs } from './use-runtime-session-mirror-environment-key'
import { createServerLayoutFrameTranslator } from './server-layout-frame-ids'
import { openWorkspaceLayoutFrameSync } from './workspace-layout-frame-sync'
import { mirroredRuntimeEnvironmentIdForWorkspace } from './web-session-tabs-sync/mirrored-workspace-owner'
import {
  isFrameDrawnServerWorkspace,
  mirroredTerminalHandle,
  onMirroredTerminalHandlesChanged,
  resyncMirroredServerWorkspace,
  setFrameDrawnServerWorkspaces
} from './web-session-tabs-sync/frame-drawn-server-workspaces'

type FramesStore = {
  getState: () => AppState
  setState: (patch: Partial<AppState>) => void
  subscribe: (listener: (state: AppState) => void) => () => void
}

type ServerFrames = {
  /** Hands the server's workspaces back to the mirror unless a replacement stream takes them. */
  close: (handBack: boolean) => void
  /** The workspaces the mirror leaves to this stream now. */
  gated: () => ReadonlySet<string>
}

/** Workspaces this server's stream draws: ones the window holds that it mirrors from this server. */
function serverDraws(environmentId: string): (state: AppState) => (key: string) => boolean {
  return (state) => (key) =>
    (key in state.groupsByWorktree || key in state.unifiedTabsByWorktree) &&
    mirroredRuntimeEnvironmentIdForWorkspace(state, key) === environmentId
}

function openServerFrames(
  store: FramesStore,
  environmentId: string,
  /** A replaced stream's workspaces: this one hands them back if it never takes them over. */
  inherited: ReadonlySet<string>
): ServerFrames {
  const translator = createServerLayoutFrameTranslator(
    environmentId,
    (worktreeId) => (hostTabId, leafId) =>
      mirroredTerminalHandle(environmentId, worktreeId, hostTabId, leafId)
  )
  const owns = (key: string): boolean =>
    mirroredRuntimeEnvironmentIdForWorkspace(store.getState(), key) === environmentId
  let gated = inherited
  /** From the stream's snapshot until it stops: only then do its frames draw. */
  let live = false
  const gate = (keys: ReadonlySet<string>): void => {
    gated = keys
    setFrameDrawnServerWorkspaces(environmentId, keys)
  }
  const regate = (): boolean => {
    const keys = new Set(translator.keys().filter(owns))
    const changed = keys.size !== gated.size || [...keys].some((key) => !gated.has(key))
    if (changed) {
      gate(keys)
    }
    return changed
  }
  const handBack = (): void => {
    live = false
    const keys = [...gated]
    gate(new Set())
    for (const key of keys) {
      // The frame tree stays until the fresh snapshot replaces it: never an empty tree between.
      resyncMirroredServerWorkspace(environmentId, key).catch((error: unknown) => {
        console.warn('[layout-owner] a server workspace could not return to the mirror:', error)
      })
    }
  }

  const sync = openWorkspaceLayoutFrameSync(store, {
    target: { kind: 'environment', environmentId },
    draws: serverDraws(environmentId),
    translate: (frame) => {
      const translated = translator.translate(frame)
      live ||= frame.type === 'snapshot'
      // Before the frame shows: the mirror must not write a workspace the frames now draw.
      regate()
      return translated
    },
    onStatus: (status) => {
      if (status.state === 'lost' || status.state === 'refused') {
        handBack()
      }
    }
  })
  // A workspace can turn out to be this server's after its snapshot (pairing just finished): it is
  // gated, then drawn, as the routing that names it arrives.
  let routing: unknown[] = []
  const stopRouting = store.subscribe((state) => {
    const next = Object.values(selectRuntimeSessionMirrorTargetInputs(state))
    if (sameValues(next, routing)) {
      return
    }
    routing = next
    if (live && regate()) {
      sync.redraw()
    }
  })
  const stopHandles = onMirroredTerminalHandlesChanged((environment, worktreeId) => {
    const frame = environment === environmentId ? translator.rebind(worktreeId) : null
    if (frame) {
      sync.receive(frame)
    }
  })
  sync.start()
  return {
    gated: () => gated,
    close: (returnWorkspaces) => {
      stopRouting()
      stopHandles()
      sync.close()
      if (returnWorkspaces) {
        handBack()
      }
    }
  }
}

/** Opens one stream per reachable server advertising the capability; reopens on a new runtime or
 *  pairing, and closes when the server is removed or stops advertising it. */
export function installServerLayoutFrames(store: FramesStore): () => void {
  const open = new Map<string, { identity: string; frames: ServerFrames }>()
  let inputs: unknown[] = []
  const reconcile = (state: AppState): void => {
    const next = Object.values(selectRuntimeSessionMirrorTargetInputs(state))
    if (sameValues(next, inputs)) {
      return
    }
    inputs = next
    const wanted = new Map<string, string>()
    for (const target of getReachableRuntimeSessionMirrorTargets(state)) {
      const status = lastVerifiedRuntimeStatus(
        state.runtimeStatusByEnvironmentId.get(target.environmentId)
      )
      if (status?.capabilities?.includes(LAYOUT_INTENTS_RUNTIME_CAPABILITY)) {
        wanted.set(
          target.environmentId,
          `${target.runtimeId}|${target.pairingRevision}|${target.connectionGeneration}`
        )
      }
    }
    const replaced = new Map<string, ReadonlySet<string>>()
    for (const [environmentId, entry] of open) {
      if (wanted.get(environmentId) !== entry.identity) {
        open.delete(environmentId)
        // A replacement stream's snapshot takes the workspaces over; anything else returns them.
        const replacing = wanted.has(environmentId)
        entry.frames.close(!replacing)
        if (replacing) {
          replaced.set(environmentId, entry.frames.gated())
        }
      }
    }
    for (const [environmentId, identity] of wanted) {
      if (!open.has(environmentId)) {
        const frames = openServerFrames(
          store,
          environmentId,
          replaced.get(environmentId) ?? new Set()
        )
        open.set(environmentId, { identity, frames })
      }
    }
  }
  reconcile(store.getState())
  const stop = store.subscribe(reconcile)
  return () => {
    stop()
    for (const { frames } of open.values()) {
      frames.close(true)
    }
    open.clear()
  }
}

/** The store slices reachability and workspace routing derive from, compared by reference. */
function sameValues(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

let installed: (() => void) | null = null

/** After restore: each capable paired server's workspaces draw from its stream from now on. */
export function showServerLayoutFrames(): void {
  // Kept for the document's life: a re-run boot reuses the streams already open.
  installed ??= installServerLayoutFrames(useAppStore)
  if (import.meta.env.MODE === 'e2e') {
    window.__isFrameDrawnServerWorkspaceE2E = isFrameDrawnServerWorkspace
  }
}
