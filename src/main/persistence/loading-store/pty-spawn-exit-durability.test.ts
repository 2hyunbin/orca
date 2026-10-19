import { completePaneAdoption } from '../../ipc/pty/pane/complete-pane-adoption'
import type { IPtyProvider } from '../../providers/pty-provider-contract'
import { expect, it, vi } from 'vitest'
import { fixture, admitRuntimeSpawnPane } from './profile-state-delayed-authority-fixture'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { commitRuntimePtySpawn } from '../../ipc/pty/runtime/spawn-commit'
import { createRuntimePtySpawnState } from '../../ipc/pty/runtime/spawn-state'
import type { PtyRuntimeControllerDeps } from '../../ipc/pty/runtime/controller-deps'
import { commitPtyIpcSpawn } from '../../ipc/pty/ipc/spawn-commit'
import { createPtyIpcSpawnState } from '../../ipc/pty/ipc/spawn-state'
import type { PtySpawnIpcDeps } from '../../ipc/pty/ipc/spawn-types'
import { registerPersistedPtySpawn } from '../../ipc/pty/pane/spawn-registration'
import { clearProviderPtyState } from '../../ipc/pty/provider/state-cleanup'
import { ptyOwnership, ptyIncarnationById } from '../../ipc/pty/provider/ownership-state'
import { ptySizes } from '../../ipc/pty/delivery/visibility-state'
import {
  paneSpawnReservationsByOwnerKey,
  reservePaneSpawn,
  reserveIdlePaneSpawn,
  resolvePaneSpawnReservation,
  type PaneSpawnReservation
} from '../../ipc/pty/pane/spawn-reservation'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

it.each(
  [
    { controller: 'runtime', exitCode: 0 },
    { controller: 'ipc', exitCode: -1 }
  ].flatMap((test) => [
    { ...test, stableOwner: false },
    { ...test, stableOwner: true }
  ])
)(
  'retires an exited $controller binding after disk finishes (stable: $stableOwner)',
  async ({ controller, exitCode, stableOwner }) => {
    const connectionId = null
    const { store, authority, readState } = await fixture()
    const runtime = new OrcaRuntimeService(store)
    const binding = {
      worktreeId: 'repo-local::/fixture/local',
      tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ptyId: 'pty-exited-during-durable-bind',
      incarnationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    }
    const owner = stableOwner
      ? {
          ...binding,
          hasPersistedBinding: true as const,
          persistedIncarnationId: 'previous-incarnation'
        }
      : null
    if (owner) {
      await store.persistPtyBinding({ ...binding, incarnationId: owner.persistedIncarnationId })
    }
    if (!stableOwner) {
      runtime.onPtySpawned(binding.ptyId, binding.incarnationId)
      runtime.beginPtyRegistration(binding.ptyId, binding.incarnationId)
    }
    let commit: () => Promise<unknown>
    const reservationKey = JSON.stringify([connectionId, binding.worktreeId, binding.leafId])
    let reservation: PaneSpawnReservation | undefined
    if (owner) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: adoption invokes only spawn; process creation and shutdown are unreachable.
      const provider = {
        spawn: async () => ({
          id: binding.ptyId,
          incarnationId: binding.incarnationId,
          isReattach: true
        })
      } as IPtyProvider
      commit = async () =>
        (
          await completePaneAdoption({
            runtime,
            store,
            owner,
            provider,
            worktreeId: binding.worktreeId,
            renderer: controller === 'ipc',
            spawnOptions: { cols: 80, rows: 24 }
          })
        )?.result
    } else if (controller === 'runtime') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only commit runs; its runtime/store are real and preflight-only dependencies are unreachable.
      const deps = { runtime, store, options: {} } as PtyRuntimeControllerDeps
      const ctx = createRuntimePtySpawnState(deps, { ...binding, connectionId, cols: 80, rows: 24 })
      ctx.result = { id: binding.ptyId, incarnationId: binding.incarnationId }
      ctx.stablePaneOwner = owner
      await admitRuntimeSpawnPane(store, binding, connectionId)
      ctx.hostSessionBinding = { store, ...binding }
      ctx.metadataLeafId = binding.leafId
      commit = () => commitRuntimePtySpawn(ctx)
    } else {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only commit runs; its runtime/store are real and preflight-only dependencies are unreachable.
      const deps = { runtime, store } as PtySpawnIpcDeps
      const ctx = createPtyIpcSpawnState(deps, { ...binding, connectionId, cols: 80, rows: 24 })
      ctx.result = { id: binding.ptyId, incarnationId: binding.incarnationId }
      ctx.stablePaneOwner = owner
      ctx.metadataLeafId = binding.leafId
      ctx.validatedLeafId = binding.leafId
      reservation = reservePaneSpawn(reservationKey)
      ctx.paneSpawnReservationKey = reservationKey
      ctx.paneSpawnReservation = reservation
      commit = () => commitPtyIpcSpawn(ctx)
    }
    const gate = authority.pause()
    const pending =
      controller === 'ipc'
        ? expect(commit()).resolves.toMatchObject({
            id: binding.ptyId,
            incarnationId: binding.incarnationId
          })
        : expect(commit()).rejects.toThrow('agent_session_exited_during_start')
    await gate.started.promise
    const nextReservation = reservation ? reserveIdlePaneSpawn(reservationKey) : undefined
    clearProviderPtyState(binding.ptyId)
    ptyOwnership.delete(binding.ptyId)
    await runtime.onPtyExit(binding.ptyId, exitCode, binding.incarnationId, {
      providerExitObserved: true
    })
    gate.finish.resolve()
    await pending
    expect(ptyOwnership.has(binding.ptyId)).toBe(false)
    expect(ptyIncarnationById.has(binding.ptyId)).toBe(false)
    expect(ptySizes.has(binding.ptyId)).toBe(false)
    if (reservation) {
      await expect(reservation.promise).resolves.toMatchObject({ id: binding.ptyId })
      const next = await nextReservation
      expect(next).not.toBe(reservation)
      resolvePaneSpawnReservation(reservationKey, next, { id: 'next-spawn' })
      expect(paneSpawnReservationsByOwnerKey.has(reservationKey)).toBe(false)
    }
    const session = readState().workspaceSession
    expect(
      session.terminalLayoutsByTabId[binding.tabId]?.ptyIdsByLeafId?.[binding.leafId]
    ).toBeUndefined()
  }
)

const binding = {
  worktreeId: 'repo-local::/fixture/local',
  tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ptyId: 'exited-pty',
  incarnationId: 'old-incarnation'
}

it.each(['replacement-pty', binding.ptyId])(
  'preserves a replacement binding to %s while retirement waits',
  async (ptyId) => {
    const { store, authority, readState } = await fixture()
    const runtime = new OrcaRuntimeService(store)
    runtime.beginPtyRegistration(binding.ptyId, binding.incarnationId)
    await store.persistPtyBinding(binding)
    await runtime.onPtyExit(binding.ptyId, 0, binding.incarnationId, { providerExitObserved: true })
    const gate = authority.pause()
    const replacement = store.persistPtyBinding({
      ...binding,
      ptyId,
      incarnationId: 'new-incarnation'
    })
    await gate.started.promise
    const registration = expect(
      registerPersistedPtySpawn(runtime, store, binding.ptyId, binding.worktreeId, null, binding)
    ).rejects.toThrow('agent_session_exited_during_start')
    gate.finish.resolve()
    await Promise.all([replacement, registration])
    const session = readState().workspaceSession
    expect(session.terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId[binding.leafId]).toBe(ptyId)
    expect(session.terminalPtyIncarnationsByPaneKey[`${binding.tabId}:${binding.leafId}`]).toBe(
      'new-incarnation'
    )
  }
)

it('retains the binding when loss of contact supplies no process-exit proof', async () => {
  const { store, readState } = await fixture()
  const runtime = new OrcaRuntimeService(store)
  runtime.beginPtyRegistration(binding.ptyId, binding.incarnationId)
  await store.persistPtyBinding(binding)
  await runtime.onPtyExit(binding.ptyId, -1, binding.incarnationId)
  expect(() =>
    registerPersistedPtySpawn(runtime, store, binding.ptyId, binding.worktreeId, null, binding)
  ).toThrow('agent_session_exited_during_start')
  expect(
    readState().workspaceSession.terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId[
      binding.leafId
    ]
  ).toBe(binding.ptyId)
})

it('does not settle rejected registration until its exit cleanup reaches SQLite', async () => {
  const { store, authority, readState } = await fixture()
  const runtime = new OrcaRuntimeService(store)
  runtime.beginPtyRegistration(binding.ptyId, binding.incarnationId)
  await store.persistPtyBinding(binding)
  await runtime.onPtyExit(binding.ptyId, 0, binding.incarnationId, { providerExitObserved: true })
  const gate = authority.pause()
  let rejected = false
  const cleanup = registerPersistedPtySpawn(
    runtime,
    store,
    binding.ptyId,
    binding.worktreeId,
    null,
    binding
  )
  if (!cleanup) {
    throw new Error('exited registration did not start durable cleanup')
  }
  const pending = cleanup.catch((error: unknown) => {
    rejected = true
    throw error
  })
  const failure = expect(pending).rejects.toThrow('agent_session_exited_during_start')
  await gate.started.promise
  expect(rejected).toBe(false)
  expect(
    readState().workspaceSession.terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId[
      binding.leafId
    ]
  ).toBe(binding.ptyId)
  gate.finish.resolve()
  await failure
  expect(
    readState().workspaceSession.terminalLayoutsByTabId[binding.tabId]?.ptyIdsByLeafId?.[
      binding.leafId
    ]
  ).toBeUndefined()
})

it('keeps successful registration synchronous through the remaining spawn publication', async () => {
  const { store } = await fixture()
  const runtime = new OrcaRuntimeService(store)
  await store.persistPtyBinding(binding)
  expect(
    registerPersistedPtySpawn(runtime, store, binding.ptyId, binding.worktreeId, null, binding)
  ).toBeUndefined()
})

it.each(['success', 'provider-exit', 'newer-claim'] as const)(
  'owns the pending same-ID incarnation through adoption: %s',
  async (event) => {
    const { store, authority } = await fixture()
    const runtime = new OrcaRuntimeService(store)
    await store.persistPtyBinding(binding)
    const begin = vi.spyOn(runtime, 'beginPtyRegistration')
    let newer: ReturnType<typeof runtime.beginPtyRegistration> | undefined
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this actual adoption path calls only the provider spawn method.
    const provider = {
      spawn: async () => {
        if (event === 'provider-exit') {
          await runtime.onPtyExit(binding.ptyId, 0, 'new-incarnation', {
            providerExitObserved: true
          })
        }
        if (event === 'newer-claim') {
          newer = runtime.beginPtyRegistration(binding.ptyId, 'successor-incarnation')
        }
        return {
          id: binding.ptyId,
          incarnationId: 'new-incarnation',
          isReattach: true,
          snapshot: 'history before attach\r\n',
          providerSequence: { value: 10, generation: 'continued' as const }
        }
      }
    } as IPtyProvider
    const gate = event === 'success' ? authority.pause() : undefined
    const operation = completePaneAdoption({
      runtime,
      store,
      provider,
      owner: {
        ...binding,
        hasPersistedBinding: true,
        persistedIncarnationId: binding.incarnationId
      },
      worktreeId: binding.worktreeId,
      spawnOptions: { cols: 80, rows: 24 }
    })
    if (gate) {
      await gate.started.promise
      runtime.onPtyData(binding.ptyId, 'live during save\r\n', 11)
      gate.finish.resolve()
    }
    if (event === 'success') {
      await expect(operation).resolves.toMatchObject({
        result: { incarnationId: 'new-incarnation', snapshotSeq: 10 }
      })
      const history = await runtime.serializeMainTerminalBuffer(binding.ptyId)
      expect(history?.data).toContain('history before attach')
      expect(history?.data).toContain('live during save')
      expect(runtime.getPtyOutputSequence(binding.ptyId)).toBe(11)
    } else {
      await expect(operation).rejects.toThrow(
        event === 'provider-exit'
          ? 'agent_session_exited_during_start'
          : 'terminal_pane_owner_changed'
      )
    }
    expect(
      runtime.narrowPtyRegistration(binding.ptyId, begin.mock.results[0].value, 'new-incarnation')
    ).toBe(false)
    if (newer) {
      expect(runtime.narrowPtyRegistration(binding.ptyId, newer, 'successor-incarnation')).toBe(
        true
      )
      runtime.cancelPendingPtyRegistration(binding.ptyId, 'successor-incarnation', newer)
    }
  }
)
