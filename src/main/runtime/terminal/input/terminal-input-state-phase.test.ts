import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeWithRuntimeId } from '../../orca-runtime-runtime-id'
import { OrcaRuntimeWithGetPtyRecordForPaneKey } from '../../orca-runtime-get-pty-record-for-pane-key'

class MailSchedulerPhaseProbe extends OrcaRuntimeWithRuntimeId {
  readonly pendingMailDuringConstruction = this.mailPointerRepointScheduler.pendingCount
}

class MailControlSchedulerIdentityProbe extends OrcaRuntimeWithGetPtyRecordForPaneKey {
  readonly sharesOriginalScheduler =
    this.mailboxControl.mailPointerRepointScheduler === this.mailPointerRepointScheduler
}

class ConstructorMailStatusProbe extends OrcaRuntimeService {
  protected override get canonicalFetchKeyCache(): ReadonlyMap<string, string> {
    this.onStructuredSessionStatusForMail({ sessionId: 'construction', status: 'working' })
    return super.canonicalFetchKeyCache
  }
}

describe('input state before later runtime layers initialize', () => {
  it('makes the scheduler available immediately after the original base layer', () => {
    expect(new MailSchedulerPhaseProbe().pendingMailDuringConstruction).toBe(0)
  })

  it('preserves mail method reentry from the original constructor getter seam', () => {
    expect(() => new ConstructorMailStatusProbe()).not.toThrow()
  })

  it('shares the original scheduler when mailbox command wiring initializes', () => {
    expect(new MailControlSchedulerIdentityProbe().sharesOriginalScheduler).toBe(true)
  })
})
