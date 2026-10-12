// The holder over a fake Store, shared by the holder's tests and the layout command tests.

import { vi } from 'vitest'
import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorkspaceLayoutEvent } from '../../shared/workspace-layout/workspace-layout-stream-frames'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf
} from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { RuntimeWorkspaceLayouts } from './runtime-workspace-layouts'

export const SSH_HOST: ExecutionHostId = 'ssh:box'
export const SERVER_HOST: ExecutionHostId = 'runtime:env-1'
export const SERVER_KEY = 'repo-server::/srv/app'
export const SSH_KEY = 'repo-ssh::/home/dev/api'

export function fakeStore(sessions: Partial<Record<ExecutionHostId, WorkspaceSessionState>>) {
  const listeners = new Set<() => void>()
  const all: Record<string, WorkspaceSessionState> = { local: emptySession() }
  for (const [hostId, session] of Object.entries(sessions)) {
    if (session) {
      all[hostId] = session
    }
  }
  const store = {
    sessions: all,
    getWorkspaceSessionHostIds: () =>
      Object.keys(store.sessions).flatMap((id) => parseExecutionHostId(id)?.id ?? []),
    getWorkspaceSession: (hostId?: string | null) => store.sessions[hostId ?? 'local']!,
    setWorkspaceSession: vi.fn((session: WorkspaceSessionState, hostId?: string | null) => {
      store.sessions[hostId ?? 'local'] = session
      listeners.forEach((listener) => listener())
    }),
    onWorkspaceSessionWritten: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return store
}

export function holderFor(
  store: ReturnType<typeof fakeStore>,
  live = new Set<string>(),
  options: { frozen?: ExecutionHostId } = {}
) {
  const stopped: string[] = []
  const holder = new RuntimeWorkspaceLayouts({
    store: () => store,
    homeHostId: (key) => (key === SERVER_KEY ? SERVER_HOST : key === SSH_KEY ? SSH_HOST : 'local'),
    isFrozenPartition: (hostId) => hostId === options.frozen,
    terminal: (ptyId) => ({
      fact: live.has(ptyId) ? 'live' : null,
      ...(live.has(ptyId) ? { liveTitle: `title of ${ptyId}` } : {})
    }),
    stopTerminals: (ptyIds) => stopped.push(...ptyIds)
  })
  holder.load()
  const events: WorkspaceLayoutEvent[] = []
  holder.subscribe((event) => events.push(event))
  return { holder, events, stopped }
}

export function gitSession(): WorkspaceSessionState {
  return addWorkspace(emptySession(), GIT_KEY, [
    { id: 'group-a', tabs: [{ id: 'tab-1', leaves: [[leaf(1), 'pty-1']] }] }
  ])
}
