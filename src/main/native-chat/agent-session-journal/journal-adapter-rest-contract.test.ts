import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { afterEach, expect, it, vi } from 'vitest'
import {
  openProviderTimelineRig,
  closeProviderTimelineRigs,
  SESSION,
  type ProviderTimelineRig
} from '../agent-session-timeline/provider-timeline-assembler-test-support'
import { acpLaunchSpecFor } from '../../acp/acp-launch-specs'
import { openAcpFixtureRig, readAcpFixture } from '../../acp/acp-timeline-fixture.test-support'
import { createCodexJournalTranslator } from '../../codex/codex-structured-journal-translation'
import { readCodexThreadId } from '../../codex/codex-structured-thread-facts'
import { createClaudeJournalTranslator } from '../../claude/claude-structured-journal-translation'
import { JsonlRpcTimelineLane } from '../../jsonl-rpc/timeline-lane'
import { PiRpcTurns } from '../../pi/rpc-turns'
import { STRUCTURED_AGENT_RUNTIME_CATALOG } from '../../runtime/structured-agent-runtime-metadata'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import {
  codexProviderHandle,
  claudeProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'

afterEach(closeProviderTimelineRigs)
const capture = (path: string): unknown[] =>
  readFileSync(resolve(import.meta.dirname, '../..', path), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
const acp = [
  ['grok', 's1-basic', 's3-cancel', 9],
  ['opencode', 'opencode-v1-tool', 'opencode-v1-subagent-hang', 13],
  ['opencode2', 'opencode-v2-tool', 'opencode-v2-stop', 14],
  ['omp', 'omp-v17-shell-ok', 'omp-v17-stop-mid-tool', 8],
  ['antigravity', 'antigravity-v1-question', null, 0]
] as const

async function durable(rig: ProviderTimelineRig, cut: boolean) {
  const turns = (await rig.rows()).filter((item) => readAgentJournalTurn(item.body))
  expect(turns.length).toBeGreaterThan(0)
  const fact = rig.restFacts()?.openTurn
  expect(fact !== null).toBe(cut)
  const reopened = await rig.reopenJournal()
  expect(reopened.restFact()).toEqual(fact)
  await reopened.close()
}

it('covers the registered roster with captured CLI finish, running-prefix cuts and available cancellations', async () => {
  expect(
    STRUCTURED_AGENT_RUNTIME_CATALOG.map((entry) => entry.metadata.definition.agent).sort()
  ).toEqual(['claude', 'codex', 'pi', ...acp.map(([agent]) => agent)].sort())
  for (const [agent, finish, stop, stopLines] of acp) {
    const spec = acpLaunchSpecFor(agent)!
    for (const scenario of ['finish', 'cut', ...(stop ? ['stop'] : [])]) {
      const frames = await readAcpFixture(scenario === 'stop' ? stop! : finish)
      const source = scenario === 'stop' ? frames.slice(0, stopLines) : frames
      const prefix = source.findIndex(
        (frame) =>
          frame.direction === 'in' &&
          frame.message.result &&
          z.object({ stopReason: z.string() }).safeParse(frame.message.result).success
      )
      const replay = await openAcpFixtureRig(spec.dialect, {
        agent,
        providerHandle: { transport: 'acp', agent, nativeId: 'session-1' }
      })
      await replay.feed(scenario === 'cut' ? source.slice(0, prefix) : source)
      if (scenario === 'cut') {
        await replay.rig.restart()
      }
      await durable(replay.rig, scenario !== 'finish')
    }
  }
  // Antigravity has no recorded cancel frame; shared ACP cancellation is exercised above.
  for (const scenario of ['finish', 'stop', 'cut']) {
    const codexFrames = z
      .array(
        z.object({
          case: z.string(),
          t: z.number(),
          method: z.string(),
          params: z.record(z.string(), z.unknown())
        })
      )
      .parse(capture('codex/__fixtures__/codex-app-server-turn-endings.jsonl'))
      .filter(
        (frame) => frame.case === (scenario === 'stop' ? '0.158.0-interrupt' : '0.158.0-control')
      )
    const rig = await openProviderTimelineRig(
      {},
      { agent: 'codex', providerHandle: codexProviderHandle('thread-1') }
    )
    const threadId = readCodexThreadId(codexFrames[0]?.params)!
    const translator = createCodexJournalTranslator({
      sink: rig.eventSink,
      sessionId: SESSION,
      primaryThreadId: () => threadId
    })
    for (const frame of codexFrames) {
      if (scenario === 'cut' && frame.method === 'turn/completed') {
        break
      }
      translator.handle({
        type: 'notification',
        sessionId: SESSION,
        threadId,
        method: frame.method,
        params: frame.params,
        observedAt: frame.t
      })
    }
    if (scenario === 'cut') {
      await rig.restart()
    }
    await durable(rig, scenario !== 'finish')

    const claudeFrames = z
      .array(
        z.object({
          at: z.number(),
          kind: z.string(),
          frame: z.record(z.string(), z.unknown()).optional()
        })
      )
      .parse(
        capture(
          `claude/__fixtures__/${scenario === 'stop' ? 'claude-lifecycle-capture-interrupt-lost' : 'claude-adapter-capture-fold'}.jsonl`
        )
      )
    const claudeRig = await openProviderTimelineRig(
      {},
      { agent: 'claude', providerHandle: claudeProviderHandle('session-1', null) }
    )
    const claude = createClaudeJournalTranslator({ sink: claudeRig.eventSink })
    for (const event of claudeFrames) {
      if (event.kind !== 'frame' || !event.frame) {
        continue
      }
      if (scenario === 'cut' && event.frame.type === 'result') {
        break
      }
      claude.handle({
        type: 'message',
        sessionId: SESSION,
        message: event.frame,
        observedAt: event.at,
        ...(event.frame.type === 'user' && event.frame.isReplay === true
          ? { startsTurn: true as const }
          : {})
      })
    }
    claude.flush()
    claude.dispose()
    if (scenario === 'cut') {
      await claudeRig.restart()
    }
    await durable(claudeRig, scenario !== 'finish')

    const frames = z
      .array(z.object({ dir: z.string(), raw: z.string() }))
      .parse(
        capture(`pi/__fixtures__/${scenario === 'stop' ? 'stop-mid-tool' : 'steer-followup'}.jsonl`)
      )
      .map((frame) => ({
        ...frame,
        body: z.record(z.string(), z.unknown()).parse(JSON.parse(frame.raw))
      }))
    const piRig = await openProviderTimelineRig(
      { agent: 'pi' },
      { agent: 'pi', providerHandle: { transport: 'pi-rpc', agent: 'pi', nativeId: 'pi-session' } }
    )
    const lane = new JsonlRpcTimelineLane({
      sink: piRig.sink,
      sessionId: SESSION,
      agent: 'pi',
      generation: 'gen-pi',
      namespace: 'pi-session',
      pauseReading: vi.fn(),
      resumeReading: vi.fn(),
      onInputAccepted: vi.fn(),
      onFailed: vi.fn()
    })
    const turns = new PiRpcTurns({
      lane,
      generation: 'gen-pi',
      send: async () => {},
      request: async (command) =>
        frames.findLast((frame) => frame.dir === 'out' && frame.body.command === command)?.body
          .data,
      settled: vi.fn(),
      failed: vi.fn(),
      idle: vi.fn()
    })
    let send = 0
    for (const frame of frames) {
      if (scenario === 'cut' && frame.body.type === 'agent_end') {
        break
      }
      if (frame.dir === 'in' && frame.body.type === 'prompt') {
        await turns.submit(`send-${++send}`, 100, frame.body)
      }
      if (frame.dir === 'in' && frame.body.type === 'abort') {
        turns.stop()
      }
      if (
        frame.dir === 'out' &&
        (frame.body.type !== 'response' || frame.body.command === 'prompt')
      ) {
        turns.receive(frame.body)
      }
      if (frame.dir === 'out' && frame.body.command === 'get_state') {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    lane.flush()
    turns.end()
    lane.dispose()
    if (scenario === 'cut') {
      await piRig.restart()
    }
    await durable(piRig, scenario !== 'finish')
  }
}, 30_000)
