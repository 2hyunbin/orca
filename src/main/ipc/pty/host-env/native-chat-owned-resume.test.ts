import { describe, expect, it, vi } from 'vitest'
import { dropAgentLaunch, nativeChatOwnsSpawnResume } from './native-chat-owned-resume'

const RESUME = {
  launchAgent: 'claude' as const,
  resumeProviderSession: { key: 'session_id' as const, id: 'b6bd7d57-2ec3-4e62-a47d-715e2455301d' }
}

describe('nativeChatOwnsSpawnResume', () => {
  it('never consults this host for a remote or WSL conversation', () => {
    const runtime = { openAgentSessionRecordStore: vi.fn() }

    expect(nativeChatOwnsSpawnResume(runtime, { ...RESUME, connectionId: 'ssh-1' }, null)).toBe(
      null
    )
    expect(nativeChatOwnsSpawnResume(runtime, RESUME, 'Ubuntu')).toBe(null)
    expect(nativeChatOwnsSpawnResume(runtime, { launchAgent: 'claude' }, null)).toBe(null)
    expect(runtime.openAgentSessionRecordStore).not.toHaveBeenCalled()
  })
})

describe('dropAgentLaunch', () => {
  it('leaves only the plain shell and the caller env the agent did not add', () => {
    const args = {
      ...RESUME,
      command: 'claude --resume x',
      launchToken: 'launch-token-1',
      launchConfig: { agentArgs: '', agentEnv: { ANTHROPIC_MODEL: 'opus' } },
      env: { ORCA_AGENT_LAUNCH_TOKEN: 'launch-token-1', ANTHROPIC_MODEL: 'opus', FOO: 'bar' }
    }

    dropAgentLaunch(args)

    expect(args).toEqual({ env: { FOO: 'bar' } })
  })
})
