import type { Mock } from 'vitest'
import type { CliChatResumeSource } from './cli-chat-resume-source'

export type CliChatResumeTestMocks = {
  source: CliChatResumeSource | null
  realSource: boolean
  sourceCapability: Mock
  createCapability: Mock
  call: Mock
  toast: Mock
  success: Mock
  activate: Mock<() => Promise<boolean>>
  activateVerified: Mock<() => Promise<string>>
  switchCapability: Mock<() => Promise<boolean>>
  exitWatchers: Map<string, () => void>
  rpc: Mock<(...args: unknown[]) => Promise<object>>
  inspect: Mock<(ptyId: string) => Promise<{ foregroundProcessEvidence?: unknown }>>
}
