import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import { RelayAgentHookServer } from './agent-hook-server'
import { AgentHookServer } from '../main/agent-hooks/server'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

async function post(relay: RelayAgentHookServer, payload: Record<string, unknown>): Promise<void> {
  const { port, token } = relay.getCoordinates()
  const response = await fetch(`http://127.0.0.1:${port}/hook/codex`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
    body: JSON.stringify({ paneKey: PANE_KEY, tabId: 'tab-1', worktreeId: 'folder-1', payload })
  })
  expect(response.status).toBe(204)
}

it('keeps a remote main Codex turn working through a /side chat after the relay restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-codex-side-'))
  const desktop = new AgentHookServer()
  const forward = (envelope: AgentHookRelayEnvelope): void =>
    void desktop.ingestRemote(envelope, 'ssh-connection')
  let relay = new RelayAgentHookServer({ endpointDir: dir, forward })
  await relay.start()
  try {
    const main = { session_id: 'main-session', transcript_path: join(dir, 'rollout-main.jsonl') }
    await post(relay, { ...main, hook_event_name: 'UserPromptSubmit', prompt: 'remote main' })
    // A restarted relay (or one without its own check) forwards the side thread's hooks.
    relay.stop()
    relay = new RelayAgentHookServer({ endpointDir: dir, forward })
    await relay.start()
    const side = { session_id: 'side-session', transcript_path: null }
    await post(relay, { ...side, hook_event_name: 'SessionStart', source: 'fork' })
    await post(relay, { ...side, hook_event_name: 'UserPromptSubmit', prompt: 'side chat' })
    await post(relay, { ...side, hook_event_name: 'Stop' })
    expect(desktop.getStatusSnapshot()[0]).toMatchObject({
      connectionId: 'ssh-connection',
      state: 'working',
      prompt: 'remote main',
      providerSession: { id: 'main-session' }
    })
    await post(relay, { ...main, hook_event_name: 'Stop' })
    expect(desktop.getStatusSnapshot()[0]).toMatchObject({ state: 'done' })
  } finally {
    relay.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
