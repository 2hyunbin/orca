import { WslRelayRecovery, type WslRelayRestartSetup } from './wsl-hook-relay-recovery'
import type { WslHookRelayManagerDeps } from './wsl-hook-relay-deps'
import type { WslRelayDistroState } from './wsl-hook-relay-state'
import { wslHookRelayStateKey } from './wsl-hook-relay-state-key'
import { FAILURE_COOLDOWN_MAX_MS } from './wsl-hook-relay-deps'

type RelayFailureState = {
  distro: string
  phase: 'starting' | 'running' | 'failed'
  failures: number
  cooldownUntil: number
  child?: unknown
  mux?: { dispose(): void }
  reinstallTimer?: ReturnType<typeof setTimeout>
}

type RelayFailureDeps = {
  warn(message: string): void
}

type RelayRecovery = {
  scheduleRestart(state: RelayFailureState): void
}

export function markWslRelayFailed(
  state: RelayFailureState,
  message: string,
  options: { cooldownBaseMs: number },
  deps: RelayFailureDeps,
  recovery: RelayRecovery
): void {
  state.phase = 'failed'
  state.failures++
  state.child = undefined
  state.mux = undefined
  if (state.reinstallTimer) {
    clearTimeout(state.reinstallTimer)
    state.reinstallTimer = undefined
  }
  state.cooldownUntil =
    Date.now() + Math.min(options.cooldownBaseMs * state.failures, FAILURE_COOLDOWN_MAX_MS)
  deps.warn(`[agent-hooks] WSL hook relay: ${message}`)
  recovery.scheduleRestart(state)
}

export function resumeWslStoppedRelays(
  stopped: Map<string, string | undefined>,
  isDistroRunning: (distro: string) => Promise<boolean>,
  ensure: (distro: string, home: string | undefined) => void
): void {
  const distros = [...stopped]
  stopped.clear()
  for (const [distro, home] of distros) {
    void isDistroRunning(distro)
      .then((running) => {
        if (running) {
          ensure(distro, home)
        }
      })
      .catch(() => undefined)
  }
}

export async function resolveWslDefaultDistro(
  current: string | null,
  listDistros: () => Promise<string[]>
): Promise<string | null> {
  if (current) {
    return current
  }
  try {
    return (await listDistros())[0] ?? null
  } catch {
    return null
  }
}

/** Brings a relay back with what it served before: the managed Codex home and pi/omp setups. */
export function restartWslRelay(
  ensure: (distro: string, codexHomePath?: string, launchKind?: 'pi' | 'omp') => Promise<void>,
  distro: string,
  setup: WslRelayRestartSetup | undefined,
  currentCodexHomePath: string | undefined
): void {
  const codexHomePath = setup?.codexHomePath ?? currentCodexHomePath
  void ensure(distro, codexHomePath)
  for (const launchKind of setup?.launchKinds ?? []) {
    void ensure(distro, codexHomePath, launchKind)
  }
}

/** The relay manager's recovery: restarts only into a distro confirmed running, never boots it. */
export function createWslRelayRecoveryForManager(manager: {
  deps: () => WslHookRelayManagerDeps
  states: Map<string, WslRelayDistroState>
  isDisposed: () => boolean
  ensure: (distro: string, codexHomePath?: string, launchKind?: 'pi' | 'omp') => Promise<void>
}): WslRelayRecovery {
  const { states } = manager
  return new WslRelayRecovery({
    isDistroRunning: (distro, startedAfter) =>
      manager.deps().isDistroRunning(distro, { startedAfter }),
    deferUntilRunning: (distro, task) =>
      manager.deps().deferUntilRunning(distro, 'wsl-hook-relay-restart', task),
    warn: (message) => manager.deps().warn(message),
    isDisposed: manager.isDisposed,
    isCurrent: (state) => states.get(wslHookRelayStateKey(state.distro)) === state,
    restart: (distro, setup) =>
      restartWslRelay(
        manager.ensure,
        distro,
        setup,
        states.get(wslHookRelayStateKey(distro))?.codexHomePath
      ),
    dropState: (state) => {
      const key = wslHookRelayStateKey(state.distro)
      if (states.get(key) === state) {
        states.delete(key)
      }
    }
  })
}
