import { expect, it } from 'vitest'
import { buildNewTabAgentMenuRows } from './new-tab-agent-menu-rows'
const input = {
  settings: { experimentalNativeChat: true, disabledTuiAgents: ['pi'] },
  detectedOnHost: ['claude', 'gemini'] as const,
  chatAgents: ['claude', 'codex', 'pi'] as const,
  hostChatAnswer: () => 'yes' as const
}
it('orders enabled chats, unavailable providers and CLI rows', () => {
  expect(buildNewTabAgentMenuRows(input)).toEqual([
    { kind: 'chat', agent: 'claude' },
    { kind: 'chat-unavailable', agent: 'codex', reason: 'not-installed' },
    { kind: 'cli', agent: 'gemini' }
  ])
})
it.each([true, false])('uses workspace installation for unchosen agents: %s', (installed) => {
  expect(
    buildNewTabAgentMenuRows({
      ...input,
      detectedOnHost: installed ? ['opencode'] : [],
      chatAgents: ['opencode']
    })
  ).toEqual(installed ? [{ kind: 'chat', agent: 'opencode' }] : [])
})
