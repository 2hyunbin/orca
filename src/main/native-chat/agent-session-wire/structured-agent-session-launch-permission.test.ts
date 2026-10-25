import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'
import { structuredAgentSessionLaunchPermission } from './structured-agent-session-launch-permission'

function launchPermission(provider: string, saved: Record<string, string> | undefined) {
  const { permissionMode, ...options } = saved ?? {}
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch mode reads only the record's agent and mode.
  const record = { sessionId: 'session-1', provider, options, permissionMode } as AgentSessionRecord
  return structuredAgentSessionLaunchPermission({ agents: claudeAndCodexDeclared() }, record)
}

describe('the permission mode a chat starts with', () => {
  it('launches the saved mode as it is', async () => {
    await expect(launchPermission('claude', { permissionMode: 'accept-edits' })).resolves.toBe(
      'accept-edits'
    )
    await expect(launchPermission('codex', { permissionMode: 'auto' })).resolves.toBe('auto')
  })

  // #30032: a resumed chat saved as auto must not relaunch as Ask when no model list is at hand.
  it('launches Claude auto without consulting a model list', async () => {
    await expect(
      launchPermission('claude', { permissionMode: 'auto', model: 'opus' })
    ).resolves.toBe('auto')
  })

  it('asks for a chat saved before modes existed, or with a mode its agent lacks', async () => {
    await expect(launchPermission('claude', undefined)).resolves.toBe('ask')
    await expect(launchPermission('codex', { permissionMode: 'accept-edits' })).resolves.toBe('ask')
  })

  it('has none for an agent with no modes', async () => {
    await expect(launchPermission('pi', { permissionMode: 'full-access' })).resolves.toBe(null)
  })
})
