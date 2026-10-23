// Claude Code 2.1.302 No/Escape captures; only identities and probe paths were scrubbed.
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createProgramStatusProjector } from '../../shared/program-status/agent-status-projector'
import { RelayAgentHookServer } from '../../wsl-guest/agent-hook-server'
import type { AgentHookRelayEnvelope } from '../../shared/agent-hook-relay'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

const SESSION = '00000000-0000-4000-8000-000000000000'
const directories: string[] = []
const servers: { stop: () => void }[] = []

function capture(action: string) {
  const lines = readFileSync(
    join(__dirname, '../../shared/__fixtures__', `claude-permission-${action}.jsonl`),
    'utf8'
  )
    .trim()
    .split('\n')
  const assistant = z
    .object({
      message: z.object({
        content: z.array(
          z.object({ id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) })
        )
      })
    })
    .parse(JSON.parse(lines[0]))
  const tool = assistant.message.content[0]
  if (!tool) {
    throw new Error('capture has no tool request')
  }
  return { lines, tool }
}

async function setup(remote = false) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-permission-result-'))
  directories.push(dir)
  const transcript = join(dir, 'session.jsonl')
  writeFileSync(transcript, '')
  const desktop = new AgentHookServer()
  servers.push(desktop)
  let connected = true
  const forwarded: AgentHookRelayEnvelope[] = []
  const relay = remote
    ? new RelayAgentHookServer({
        endpointDir: dir,
        token: 'permission-result-test',
        forward: (envelope) => {
          forwarded.push(envelope)
          if (connected) {
            desktop.ingestRemote(envelope, 'conn-1')
          }
        }
      })
    : undefined
  if (relay) {
    servers.push(relay)
    await relay.start({ publishEndpoint: false })
  } else {
    await desktop.start({ env: 'production' })
  }
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
  const post = async (payload: Record<string, unknown>) => {
    const body = buildBody({ session_id: SESSION, transcript_path: transcript, ...payload })
    if (!relay) {
      expect((await postHookEvent(desktop, body)).status).toBe(204)
    } else {
      const { port, token } = relay.getCoordinates()
      const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token,
          Connection: 'close'
        },
        body: JSON.stringify(body)
      })
      expect(response.status).toBe(204)
    }
  }
  return {
    desktop,
    relay,
    transcript,
    forwarded,
    post,
    disconnect: () => {
      connected = false
    },
    reconnect: () => {
      connected = true
      relay?.replayCachedPayloadsForPanes()
    },
    row: () => desktop.getStatusSnapshotForPane(PANE)[0],
    tick: () => vi.advanceTimersByTimeAsync(5_001)
  }
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  vi.useRealTimers()
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

async function permission(
  pane: Awaited<ReturnType<typeof setup>>,
  tool: ReturnType<typeof capture>['tool'],
  extra: Record<string, unknown> = {}
) {
  await pane.post({
    hook_event_name: 'PreToolUse',
    tool_name: tool.name,
    tool_input: tool.input,
    tool_use_id: tool.id
  })
  // Real PermissionRequest omits tool_use_id; the execution host must bind it before replacing PreToolUse.
  await pane.post({
    hook_event_name: 'PermissionRequest',
    tool_name: tool.name,
    tool_input: tool.input,
    ...extra
  })
}

function line(row: Record<string, unknown>) {
  return `${JSON.stringify(row)}\n`
}

describe('Claude permission result observation', () => {
  it.each([
    { action: 'decline', remote: false },
    { action: 'escape', remote: false },
    { action: 'decline', remote: true },
    { action: 'escape', remote: true }
  ])(
    'settles recorded $action on the execution host (relay=$remote) without resurrecting the tool',
    async ({ action, remote }) => {
      const pane = await setup(remote)
      const { lines, tool } = capture(action)
      // A result can flush before HTTP admission; initial catch-up must include it.
      writeFileSync(pane.transcript, `${lines.slice(0, remote ? 1 : lines.length).join('\n')}\n`)
      await pane.post({ hook_event_name: 'UserPromptSubmit', prompt: 'run the permission probe' })
      await permission(pane, tool)
      expect(pane.row()).toMatchObject({ state: 'waiting', toolName: 'Bash' })
      const terminal = readFileSync(
        join(__dirname, '../../shared/__fixtures__', `claude-permission-${action}.txt`),
        'utf8'
      )
      const native = createProgramStatusProjector().process(terminal)
      expect(native.payloads.at(-1)?.payload.state).toBe('done')
      for (const report of native.payloads) {
        pane.desktop.ingestTerminalStatus({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          connectionId: remote ? 'conn-1' : null,
          fromProgramStatus: true,
          payload: report.payload
        })
      }
      expect(pane.row()?.state).toBe('waiting')
      await pane.post({ hook_event_name: 'Notification', notification_type: 'permission_prompt' })
      await pane.post({
        hook_event_name: 'SubagentStart',
        agent_id: 'child',
        agent_type: 'Explore'
      })
      if (remote) {
        pane.disconnect()
        appendFileSync(pane.transcript, `${lines.slice(1).join('\n')}\n`)
      }
      await pane.tick()
      if (remote) {
        expect(pane.row()?.state).toBe('waiting')
        expect(pane.forwarded.at(-1)).toMatchObject({
          claudeSettledRequests: [{ toolUseId: tool.id }],
          payload: { state: 'working', mainAgent: { outcome: 'cancellation' } }
        })
        // Another hook overwrites the relay's one cached row before reconnect.
        await pane.post({
          hook_event_name: 'SubagentStart',
          agent_id: 'another-child',
          agent_type: 'Explore'
        })
        pane.reconnect()
      }
      expect(pane.row()).toMatchObject({
        state: 'working',
        prompt: 'run the permission probe',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
      expect(pane.row()?.toolName).toBeUndefined()
      expect(pane.row()?.interactivePrompt).toBeUndefined()
      await pane.post({ hook_event_name: 'SubagentStop', agent_id: 'child' })
      if (remote) {
        await pane.post({ hook_event_name: 'SubagentStop', agent_id: 'another-child' })
      }
      expect(pane.row()).toMatchObject({
        state: 'done',
        interrupted: true,
        mainAgent: { outcome: 'cancellation' }
      })
      expect(pane.row()?.toolName).toBeUndefined()
    }
  )

  it('releases a declined request during continued work, then applies a late complete interruption record over the live relay', async () => {
    const pane = await setup(true)
    const { lines, tool } = capture('decline')
    writeFileSync(pane.transcript, `${lines[0]}\n`)
    await permission(pane, tool)
    await pane.tick()
    expect(pane.row()?.state).toBe('waiting') // An overlay/native idle without a result is no decision.
    appendFileSync(pane.transcript, `${lines.slice(1, 3).join('\n')}\n`)
    await pane.tick()
    expect(pane.row()).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
    expect(pane.row()?.mainAgent?.outcome).toBeUndefined()
    expect(pane.row()?.interactivePrompt).toBeUndefined()
    await pane.post({ hook_event_name: 'SubagentStart', agent_id: 'child' })
    expect(pane.row()?.toolName).toBeUndefined()
    appendFileSync(pane.transcript, `${lines[3]}\n${lines[4]}`)
    await pane.tick()
    expect(pane.row()?.mainAgent?.state).toBe('working')
    appendFileSync(pane.transcript, `\n${lines[5]}\n`)
    await pane.tick()
    expect(pane.row()?.mainAgent).toMatchObject({ state: 'done', outcome: 'cancellation' })
  })

  it('keeps Q2 and child-owned permissions when Q1 settles, and rejects ambiguous full-input binding', async () => {
    const pane = await setup()
    const { lines, tool } = capture('decline')
    writeFileSync(pane.transcript, `${lines[0]}\n`)
    await permission(pane, tool)
    const rejected = z.record(z.string(), z.unknown()).parse(JSON.parse(lines[2]))
    appendFileSync(
      pane.transcript,
      line({ ...rejected, type: 'api-request-blob' }) +
        line({ ...rejected, isSidechain: true }) +
        line({ ...rejected, sessionId: 'other-session', session_id: 'other-session' })
    )
    await pane.tick()
    expect(pane.row()?.state).toBe('waiting')
    const second = { ...tool, id: 'tool-2', input: { command: 'second request' } }
    const assistant = {
      type: 'assistant',
      isSidechain: false,
      sessionId: SESSION,
      uuid: 'second-assistant',
      parentUuid: 'decline2-node-1',
      message: { role: 'assistant', content: [{ type: 'tool_use', ...second }] }
    }
    appendFileSync(pane.transcript, line(assistant))
    await permission(pane, second)
    await pane.post({
      hook_event_name: 'PreToolUse',
      tool_name: tool.name,
      tool_input: tool.input,
      tool_use_id: tool.id
    })
    expect(pane.row()).toMatchObject({ state: 'waiting', toolInput: 'second request' })
    appendFileSync(pane.transcript, `${lines.slice(1).join('\n')}\n`)
    await pane.tick()
    expect(pane.row()).toMatchObject({ state: 'waiting', toolInput: 'second request' })
    await permission(pane, tool, { agent_id: 'child', tool_use_id: tool.id })
    await pane.tick()
    expect(pane.row()?.state).toBe('waiting')
    expect(pane.row()?.toolName).toBe('Bash')
    // Separate assistant envelopes can contain indistinguishable parallel requests.
    await pane.post({ hook_event_name: 'SessionStart', source: 'startup' })
    writeFileSync(
      pane.transcript,
      `${lines[0]}\n${line({
        ...assistant,
        message: { role: 'assistant', content: [{ type: 'tool_use', ...tool, id: 'ambiguous' }] }
      })}`
    )
    await permission(pane, tool)
    appendFileSync(pane.transcript, `${lines.slice(1).join('\n')}\n`)
    await pane.tick()
    expect(pane.row()?.state).toBe('waiting')
  })

  it('re-anchors after file replacement and never combines evidence across a missing record', async () => {
    const pane = await setup()
    const { lines, tool } = capture('escape')
    writeFileSync(pane.transcript, `${lines[0]}\n`)
    await permission(pane, tool)
    const replacement = `${pane.transcript}.replacement`
    writeFileSync(replacement, `${lines.slice(1).join('\n')}\n`)
    renameSync(replacement, pane.transcript)
    await pane.tick()
    expect(pane.row()?.state).toBe('waiting')
    writeFileSync(
      pane.transcript,
      `${lines.slice(0, 3).join('\n')}\nnot-json\n${lines.slice(3).join('\n')}\n`
    )
    await pane.tick()
    expect(pane.row()?.state).toBe('waiting')
    writeFileSync(replacement, `${lines.join('\n')}\n`)
    renameSync(replacement, pane.transcript)
    await pane.tick()
    expect(pane.row()).toMatchObject({ state: 'done', interrupted: true })
    await pane.post({ hook_event_name: 'UserPromptSubmit', prompt: 'new turn' })
    await pane.tick()
    expect(pane.row()).toMatchObject({ state: 'working', prompt: 'new turn' })
    expect(pane.row()?.mainAgent?.outcome).toBeUndefined()
  })
})
