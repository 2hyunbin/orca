import { describe, expect, it } from 'vitest'
import { buildAgentFeatureSkillInstallArgs } from '../../src/shared/agent-feature-install-commands'
import { roundTripAddArgs } from './verify-skill-update-roundtrip.mjs'

describe('skill update round trip', () => {
  it('runs the shared builder’s unattended add, pinned to the PR commit instead of a tag', () => {
    const [, ...builderArgs] = buildAgentFeatureSkillInstallArgs(['orca-cli'], {
      appVersion: '1.4.222',
      yes: true,
      agents: ['claude-code', 'universal']
    })

    expect(roundTripAddArgs('stablyai/orca', 'abc123', 'orca-cli')).toEqual(
      builderArgs.map((arg) =>
        arg === 'https://github.com/stablyai/orca/tree/v1.4.222'
          ? 'https://github.com/stablyai/orca/tree/abc123'
          : arg
      )
    )
  })
})
