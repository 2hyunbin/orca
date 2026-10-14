import { describe, expect, it, vi } from 'vitest'
import { nativeChatSpawnResumeOwnership } from './native-chat-owned-resume'

const RESUME = {
  launchAgent: 'claude' as const,
  resumeProviderSession: {
    key: 'session_id' as const,
    id: 'b6bd7d57-2ec3-4e62-a47d-715e2455301d'
  }
}

describe('nativeChatSpawnResumeOwnership', () => {
  it('never consults this host for a remote or WSL conversation', () => {
    const runtime = { openAgentSessionRecordStore: vi.fn() }

    expect(
      nativeChatSpawnResumeOwnership(runtime, { ...RESUME, connectionId: 'ssh-1' }, null)
    ).toBe(null)
    expect(nativeChatSpawnResumeOwnership(runtime, RESUME, 'Ubuntu')).toBe(null)
    expect(nativeChatSpawnResumeOwnership(runtime, { launchAgent: 'claude' }, null)).toBe(null)
    expect(runtime.openAgentSessionRecordStore).not.toHaveBeenCalled()
  })
})
