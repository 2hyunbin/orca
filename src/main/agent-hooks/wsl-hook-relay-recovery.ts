export type WslRelayRecoveryState = {
  distro: string
  cooldownUntil: number
  restartTimer?: ReturnType<typeof setTimeout>
  reinstallTimer?: ReturnType<typeof setTimeout>
}

export type WslRelayRecoveryIo = {
  /** A confirmed running list read started after `startedAfter`; a failed read counts as stopped. */
  isDistroRunning: (distro: string, startedAfter: number) => Promise<boolean>
  /** Runs `task` once something else confirms the distro runs again; never boots it. */
  deferUntilRunning: (distro: string, task: () => void) => void
  warn: (message: string) => void
  isDisposed: () => boolean
  isCurrent: (state: WslRelayRecoveryState) => boolean
  restart: (distro: string) => void
  dropState: (state: WslRelayRecoveryState) => void
}

export class WslRelayRecovery {
  constructor(private io: WslRelayRecoveryIo) {}

  /** Check distro liveness before restarting so recovery cannot boot a stopped VM. */
  scheduleRestart(state: WslRelayRecoveryState): void {
    if (this.io.isDisposed() || state.restartTimer) {
      return
    }
    const delayMs = Math.max(state.cooldownUntil - Date.now(), 0) + 250
    // Only a running-list read started after the link died may say the distro still runs.
    const linkDiedAt = performance.now()
    state.restartTimer = setTimeout(() => {
      state.restartTimer = undefined
      void this.restartIfDistroRunning(state, linkDiedAt)
    }, delayMs)
    state.restartTimer.unref?.()
  }

  scheduleOneShotReinstall(state: WslRelayRecoveryState, delayMs: number, run: () => void): void {
    if (this.io.isDisposed()) {
      return
    }
    state.reinstallTimer = setTimeout(() => {
      state.reinstallTimer = undefined
      run()
    }, delayMs)
    state.reinstallTimer.unref?.()
  }

  clearTimers(state: WslRelayRecoveryState): void {
    if (state.restartTimer) {
      clearTimeout(state.restartTimer)
      state.restartTimer = undefined
    }
    if (state.reinstallTimer) {
      clearTimeout(state.reinstallTimer)
      state.reinstallTimer = undefined
    }
  }

  private async restartIfDistroRunning(
    state: WslRelayRecoveryState,
    linkDiedAt: number
  ): Promise<void> {
    if (this.io.isDisposed() || !this.io.isCurrent(state)) {
      return
    }
    const running = await this.io.isDistroRunning(state.distro, linkDiedAt)
    // The probe await may outlive state replacement; never drop or restart the replacement relay.
    if (this.io.isDisposed() || !this.io.isCurrent(state)) {
      return
    }
    if (!running) {
      this.io.warn(
        `[agent-hooks] WSL hook relay (${state.distro}): distro not running (or probe failed); staying down until it runs again or a WSL terminal re-ensures`
      )
      this.io.dropState(state)
      // E9: come back when the distro runs again (started by the user or another act), never boot it.
      this.io.deferUntilRunning(state.distro, () => {
        if (!this.io.isDisposed()) {
          this.io.restart(state.distro)
        }
      })
      return
    }
    this.io.restart(state.distro)
  }
}
