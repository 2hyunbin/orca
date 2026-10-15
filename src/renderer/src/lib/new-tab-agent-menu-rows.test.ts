import { describe, expect, it } from 'vitest'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  buildNewTabAgentMenuRows,
  type HostChatAnswer,
  type NewTabAgentMenuSettings
} from './new-tab-agent-menu-rows'

const CHAT_AGENTS: TuiAgent[] = ['claude', 'codex', 'grok', 'pi']

function rows(args: {
  settings?: Partial<NewTabAgentMenuSettings>
  installedHere?: TuiAgent[]
  detectedOnHost: TuiAgent[]
  answer?: (agent: TuiAgent) => HostChatAnswer
}) {
  return buildNewTabAgentMenuRows({
    settings: { experimentalNativeChat: true, ...args.settings },
    installedHere: args.installedHere ?? args.detectedOnHost,
    detectedOnHost: args.detectedOnHost,
    chatAgents: CHAT_AGENTS,
    hostChatAnswer: args.answer ?? (() => 'yes')
  })
}

describe('new tab agent menu rows', () => {
  it('lists chat rows, then disabled chat rows, then the agents that open a terminal', () => {
    expect(
      rows({
        // Codex is not installed on the workspace's machine; Gemini has no chat; Pi was never
        // turned on and is not installed here, so it is not listed.
        detectedOnHost: ['claude', 'grok', 'gemini'],
        settings: { nativeChatProviders: { grok: false } }
      })
    ).toEqual([
      { kind: 'chat', agent: 'claude' },
      { kind: 'chat-unavailable', agent: 'codex', reason: 'not-installed' },
      { kind: 'cli', agent: 'grok' },
      { kind: 'cli', agent: 'gemini' }
    ])
  })

  it('shows turned-on chats disabled on a machine that cannot run them, beside their CLI', () => {
    expect(
      rows({ detectedOnHost: ['claude', 'gemini'], installedHere: [], answer: () => 'ssh' })
    ).toEqual([
      { kind: 'chat-unavailable', agent: 'claude', reason: 'ssh' },
      { kind: 'chat-unavailable', agent: 'codex', reason: 'ssh' },
      { kind: 'cli', agent: 'claude' },
      { kind: 'cli', agent: 'gemini' }
    ])
  })

  it('keeps the plain menu with Chat UI off or on a server that opens no chats', () => {
    const plain = [
      { kind: 'terminal', agent: 'claude' },
      { kind: 'terminal', agent: 'gemini' }
    ]
    expect(
      rows({ detectedOnHost: ['claude', 'gemini'], settings: { experimentalNativeChat: false } })
    ).toEqual(plain)
    expect(rows({ detectedOnHost: ['claude', 'gemini'], answer: () => 'no-chats' })).toEqual(plain)
  })

  it('leaves out an agent turned off in Agent settings', () => {
    expect(
      rows({ detectedOnHost: ['claude', 'codex'], settings: { disabledTuiAgents: ['codex'] } })
    ).toEqual([{ kind: 'chat', agent: 'claude' }])
  })

  it('keeps unresolved enabled chat support visible as a pending row', () => {
    expect(rows({ detectedOnHost: ['claude'], answer: () => 'not-yet-known' })).toEqual([
      { kind: 'chat-unavailable', agent: 'claude', reason: 'pending' },
      { kind: 'chat-unavailable', agent: 'codex', reason: 'pending' },
      { kind: 'cli', agent: 'claude' }
    ])
  })
})

it('distinguishes unknown inventory, catalog and local defaults from known missing/legacy facts', () => {
  const input = {
    settings: { experimentalNativeChat: true },
    installedHere: null,
    detectedOnHost: null,
    chatAgents: ['claude', 'codex'] as const,
    catalogLoaded: false,
    hostChatAnswer: () => 'yes' as const
  }
  expect(buildNewTabAgentMenuRows(input)).toMatchObject([
    { agent: 'claude', reason: 'pending' },
    { agent: 'codex', reason: 'pending' }
  ])
  expect(buildNewTabAgentMenuRows({ ...input, detectedOnHost: ['opencode'] })).toMatchObject([
    { agent: 'claude', reason: 'not-installed' },
    { agent: 'codex', reason: 'not-installed' },
    { agent: 'opencode', reason: 'pending' }
  ])
  expect(
    buildNewTabAgentMenuRows({
      ...input,
      detectedOnHost: ['opencode'],
      settings: { ...input.settings, nativeChatProviders: { opencode: false } }
    })
  ).toContainEqual({ kind: 'cli', agent: 'opencode' })
  expect(
    buildNewTabAgentMenuRows({
      ...input,
      detectedOnHost: ['claude'],
      hostChatAnswer: () => 'no-chats'
    })
  ).toEqual([{ kind: 'terminal', agent: 'claude' }])
})
