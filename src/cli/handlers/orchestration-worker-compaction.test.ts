import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../main/runtime/orca-runtime'
import { readExactWorkerOutput } from '../../main/runtime/rpc/methods/orchestration/worker/worker-output'
import { RuntimeClient } from '../runtime-client'
import { okFixture } from '../test-fixtures'
import { ORCHESTRATION_WORKER_OBSERVATION_HANDLERS } from './orchestration/worker-observation-handlers'

let root: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  root = undefined
})

it('runs worker-read over real compaction pages in text and JSON', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-worker-compaction-'))
  const transcriptPath = join(root, 'rollout.jsonl')
  // STA-4099 observed item payload; ID and outer wrapper fields are test-supplied.
  const records = [
    { type: 'event_msg', payload: { type: 'user_message', message: 'Prompt' } },
    {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { type: 'ContextCompaction', id: 'compaction-1' }
      }
    },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Response' } }
  ]
  const methods: Pick<OrcaRuntimeService, 'getExactWorkerProviderSession'> = {
    getExactWorkerProviderSession: () => ({
      paneKey: 'tab:worker',
      processIncarnation: 'pty:compaction',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'session-1', transcriptPath },
      observedAt: 1
    })
  }
  // SAFETY: explicit transcript reads use only this runtime method; file decoding/paging stays real.
  const runtime = methods as OrcaRuntimeService
  const readArgs = {
    runtime,
    dispatchId: 'dispatch-1',
    terminalHandle: 'term-worker',
    workerState: 'ready',
    terminalStatus: 'running' as const,
    attachedAt: '2026-08-13 00:00:00',
    source: 'transcript' as const
  }
  await writeFile(transcriptPath, '')
  const seed = await readExactWorkerOutput(readArgs)
  if (typeof seed.cursor !== 'string') {
    throw new Error('Expected transcript continuation cursor')
  }
  await appendFile(
    transcriptPath,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
  )
  const client = new RuntimeClient(root, 60_000, null, null)
  const rpc = vi.fn()
  rpc.mockImplementation(
    async (method: string, params: { cursor?: string | number; limit?: number }) => {
      expect(method).toBe('orchestration.workerRead')
      return okFixture(
        'read',
        await readExactWorkerOutput({
          ...readArgs,
          cursor: params.cursor,
          limit: params.limit
        })
      )
    }
  )
  vi.spyOn(client, 'call').mockImplementation(rpc)
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const invoke = async (cursor: string, limit: number, json: boolean) => {
    log.mockClear()
    await ORCHESTRATION_WORKER_OBSERVATION_HANDLERS['orchestration worker-read']({
      client,
      cwd: root ?? tmpdir(),
      json,
      flags: new Map<string, string | boolean>([
        ['dispatch', 'dispatch-1'],
        ['source', 'transcript'],
        ['cursor', cursor],
        ['limit', String(limit)]
      ])
    })
    const output: unknown = log.mock.calls[0]?.[0]
    if (typeof output !== 'string') {
      throw new Error('Expected worker-read command output')
    }
    return output
  }
  const first = JSON.parse(await invoke(seed.cursor, 1, true))
  expect(first.result.transcript.messages.map((message: { role: string }) => message.role)).toEqual(
    ['user']
  )
  const middle = JSON.parse(await invoke(first.result.cursor, 1, true))
  expect(middle.result.transcript.messages).toMatchObject([
    {
      id: 'compaction-1',
      role: 'system',
      source: 'transcript',
      timestamp: null,
      blocks: [{ type: 'text', text: 'Context compacted', presentation: 'compaction' }]
    }
  ])
  expect(middle.result.transcript.returnedMessageCount).toBe(1)
  expect(middle.result.transcript.limited).toBe(true)
  const last = JSON.parse(await invoke(middle.result.cursor, 1, true))
  expect(last.result.transcript.messages.map((message: { role: string }) => message.role)).toEqual([
    'assistant'
  ])
  const text = await invoke(seed.cursor, 10, false)
  expect(text.match(/\[system\] Context compacted/g)).toHaveLength(1)
  expect(text.indexOf('[user] Prompt')).toBeLessThan(text.indexOf('[system] Context compacted'))
  expect(text.indexOf('[system] Context compacted')).toBeLessThan(
    text.indexOf('[assistant] Response')
  )
})
