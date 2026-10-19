/**
 * What retiring a PTY rests on. Retiring its ownership, its lease or its runtime record drops the
 * only handle a later stop could use, so every retirement names its evidence: a `PtyExitProof`
 * from the host that owns the process, or a `PtyRetirementWithoutProof` carrying the
 * `unverifiable` reason. Private constructors keep both minted only here, and
 * config/scripts/check-unproven-pty-retirement-ratchet.mjs counts every unproven mint.
 */
export type PtyExitProofSource =
  /** The owning provider emitted this incarnation's exit, or the legacy relay reported it. */
  | 'exit-observed'
  /** The owning provider's own inventory lacks it, or it answered "Session not found". */
  | 'absent'
  /** The owning provider completed the shutdown it was asked for. */
  | 'shutdown-acknowledged'
  /** A host-wide census answered `exited` for it. */
  | 'host-census'

export class PtyExitProof {
  private constructor(readonly source: PtyExitProofSource) {}

  static from(source: PtyExitProofSource): PtyExitProof {
    return new PtyExitProof(source)
  }
}

export class PtyRetirementWithoutProof {
  private constructor(readonly unverifiableReason: string) {}

  /** RATCHET: each call site is counted; a closed tab whose host can't answer still retires. */
  static because(unverifiableReason: string): PtyRetirementWithoutProof {
    return new PtyRetirementWithoutProof(unverifiableReason)
  }
}

export type PtyRetirementEvidence = PtyExitProof | PtyRetirementWithoutProof
