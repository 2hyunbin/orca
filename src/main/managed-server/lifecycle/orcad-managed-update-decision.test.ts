import { describe, expect, it } from 'vitest'
import { emptyOrcadActivationRecord } from '../activation/orcad-activation-record'
import { planOrcadUpdateForIntent } from './orcad-managed-update-decision'

const rolledBack = {
  ...emptyOrcadActivationRecord(),
  active: '1.4.0+aa',
  activeAppVersion: '1.4.0',
  rolledBackFrom: '1.5.0+ab'
}
const input = {
  record: rolledBack,
  candidateVersion: '1.5.0+ab',
  appVersion: '1.5.0',
  failedBefore: true
}

describe('the three update intents', () => {
  it('skips on a connect, and retries on an explicit Update or Force', () => {
    expect(planOrcadUpdateForIntent('connect', input)).toEqual({
      action: 'skip',
      reason: 'rolled-back'
    })
    expect(planOrcadUpdateForIntent('update', input)).toEqual({ action: 'update' })
    expect(planOrcadUpdateForIntent('force', input)).toEqual({ action: 'update' })
  })
})
