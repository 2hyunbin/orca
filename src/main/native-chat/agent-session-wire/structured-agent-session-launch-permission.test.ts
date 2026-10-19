// The mode a start launches with: Claude's Approve for me drops to Ask only on a model the saved
// catalog lists without it; a catalog that can't say keeps the saved choice.

import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'
import { structuredAgentSessionLaunchPermission } from './structured-agent-session-launch-permission'

function record(provider: string, saved: Record<string, string> | undefined): AgentSessionRecord {
  const { permissionMode, ...options } = saved ?? {}
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch mode reads only the record's id, agent, options and mode.
  return { sessionId: 'session-1', provider, options, permissionMode } as AgentSessionRecord
}

const listing = (
  models: { id: string; isDefault?: boolean; supportsAutoMode?: boolean }[]
): AgentSessionModelCatalogResult => ({
  origin: 'probe',
  fetchedAt: 1,
  models: models.map((model) => ({
    label: model.id,
    efforts: [],
    isDefault: false,
    ...model
  }))
})

function launchPermission(
  provider: string,
  options: Record<string, string> | undefined,
  answer: AgentSessionModelCatalogResult | Error = { origin: 'unknown' }
) {
  const read = vi.fn(async () => {
    if (answer instanceof Error) {
      throw answer
    }
    return answer
  })
  const modelCatalog = {
    read,
    retainedLiveModelIds: vi.fn(async () => []),
    recordLiveListing: vi.fn(),
    prewarm: vi.fn(async () => undefined),
    stop: vi.fn(),
    providerStarted: vi.fn()
  }
  return {
    read,
    result: structuredAgentSessionLaunchPermission(
      { agents: claudeAndCodexDeclared(), modelCatalog },
      record(provider, options)
    )
  }
}

describe('the permission mode a chat starts with', () => {
  it('launches a saved mode that needs no model as it is, without reading the catalog', async () => {
    const claude = launchPermission('claude', { permissionMode: 'accept-edits' })
    await expect(claude.result).resolves.toBe('accept-edits')
    expect(claude.read).not.toHaveBeenCalled()
    const codex = launchPermission('codex', { permissionMode: 'auto' })
    await expect(codex.result).resolves.toBe('auto')
    expect(codex.read).not.toHaveBeenCalled()
  })

  it('asks for a chat saved before modes existed', async () => {
    await expect(launchPermission('claude', undefined).result).resolves.toBe('ask')
  })

  it('runs Claude auto on a model the saved catalog lists as supporting it', async () => {
    const supported = launchPermission(
      'claude',
      { permissionMode: 'auto', model: 'opus' },
      listing([{ id: 'opus', supportsAutoMode: true }])
    )
    await expect(supported.result).resolves.toBe('auto')
    expect(supported.read).toHaveBeenCalledWith(expect.objectContaining({ savedOnly: true }))
  })

  it('asks on a model listed without auto, or a chat with no model whose listed default lacks it', async () => {
    const rows = listing([
      { id: 'sonnet', isDefault: true },
      { id: 'opus', supportsAutoMode: true },
      { id: 'haiku' }
    ])
    for (const options of [{ model: 'haiku' }, {}]) {
      await expect(
        launchPermission('claude', { permissionMode: 'auto', ...options }, rows).result
      ).resolves.toBe('ask')
    }
  })

  // #30032: a catalog saved under another account home read as none, and the chat relaunched asking.
  it('keeps the saved auto when the catalog cannot say whether the model runs it', async () => {
    for (const answer of [
      { origin: 'unknown' } as const,
      new Error('catalog unavailable'),
      listing([{ id: 'sonnet', supportsAutoMode: true }]),
      // A CLI that doesn't mark auto support at all.
      listing([{ id: 'opus' }, { id: 'sonnet' }])
    ]) {
      await expect(
        launchPermission('claude', { permissionMode: 'auto', model: 'opus' }, answer).result
      ).resolves.toBe('auto')
    }
  })

  it('has none for an agent with no modes', async () => {
    await expect(launchPermission('pi', { permissionMode: 'full-access' }).result).resolves.toBe(
      null
    )
  })
})
