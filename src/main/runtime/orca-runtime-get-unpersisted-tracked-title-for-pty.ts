import { OrcaRuntimeWithEmitDaemonPtyTransientFact } from './orca-runtime-emit-daemon-pty-transient-fact'

import type { RuntimePtyTitleTrackerEntry } from './runtime-terminal-state-records'

export abstract class OrcaRuntimeWithGetUnpersistedTrackedTitleForPty extends OrcaRuntimeWithEmitDaemonPtyTransientFact {
  protected getUnpersistedTrackedTitleForPty(ptyId: string | null): string | null {
    return this.terminalOutput.getUnpersistedTrackedTitleForPty(ptyId)
  }

  /** Why: synthetic agent title frames no longer ride pty:data, so neither
   *  renderer xterm nor the headless emulator observes them. Mobile-parity
   *  snapshot titles must prefer main's tracker over snapshot lastTitle, or
   *  hook-driven spinner/idle titles vanish from mobile tabs. */
  protected preferTrackedLastTitle<T extends { lastTitle?: string }>(
    ptyId: string,
    snapshot: T
  ): T {
    return this.terminalOutput.preferTrackedLastTitle(ptyId, snapshot)
  }

  /** Decorative comparison key: only recognized agent titles fold leading spinner frames. */
  protected makeDecorativeTitleGateKey(rawTitle: string, normalizedTitle: string): string {
    return this.terminalOutput.makeDecorativeTitleGateKey(rawTitle, normalizedTitle)
  }

  protected getOrCreatePtyTitleTrackerEntry(ptyId: string): RuntimePtyTitleTrackerEntry {
    return this.terminalOutput.getOrCreatePtyTitleTrackerEntry(ptyId)
  }
}
