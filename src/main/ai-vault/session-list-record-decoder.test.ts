import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { createClaudeSessionResumeState } from './session-scanner-primary-parsers'
import { createCodexSessionResumeState } from './session-scanner-codex-parser'
import { decodeSessionListRecord } from './session-list-record-decoder'

const cases: { agent: 'claude' | 'codex'; json: string }[] = [
  { agent: 'claude', json: '"customTitle":"old","type":"user","type":"custom-title","custom\\u0054itle":"日本語😀"' },
  { agent: 'claude', json: '"type":"assistant","message":{"model":"old","content":"old"},"message":{"content":["direct",{"type":"tool_result","content":"visible"},{"text":"<system-reminder>hidden</system-reminder>real"}]}' },
  ...['null', '0', '[]', '{}'].map((value) => ({ agent: 'claude' as const,
    json: `"type":"assistant","message":{"model":"old","content":"old"},"message":${value}` })),
  { agent: 'codex', json: '"type":"session_meta","payload":{"source":{"subagent":"review","__proto__":{"x":1}},"id":"kept"}' },
  { agent: 'codex', json: '"payload":{"model":"old","cwd":"/old"},"type":"turn_context","payload":{"metadata":{"model":"new"},"cwd":"/new"}' },
  { agent: 'codex', json: '"type":"event_msg","payload":{"type":"token_count","info":{},"model":"from-empty-info"}' },
  { agent: 'codex', json: '"type":"session_meta","payload":{"history_mode":"paginated"}' },
  { agent: 'claude', json: '"type":"custom-title","customTitle":"must not commit","discarded":[1,]' },
  { agent: 'codex', json: '"type":"turn_context","payload":{"cwd":"must not commit"}} trailing {' }
]

it.each(cases)('matches native reduction for $agent: $json', async ({ agent, json }) => {
  const file = { path: join(tmpdir(), 'orca-list-decoder-fixture', 'session.jsonl'),
    mtimeMs: 1, modifiedAt: '2026-05-01T00:00:00Z' }
  const create = () => agent === 'claude' ? createClaudeSessionResumeState(file) :
    createCodexSessionResumeState(file, join(tmpdir(), 'orca-list-decoder-fixture'))
  const ordinary = create()
  const selected = create()
  selected.selectListContent?.()
  const lines = [JSON.stringify(agent === 'claude' ?
    { type: 'user', message: { content: 'seed' } } :
    { type: 'event_msg', payload: { type: 'user_message', message: 'seed' } }),
  `{"ignored":"${'x'.repeat(17000)}",${json}}`,
  `{"ignored":"${'x'.repeat(17000)}","type":"event_msg","payload":{"type":"item_completed",` +
    '"item":{"type":"UserMessage","content":["completed prompt",{"text":"direct"}]}}}',
  JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed',
    item: { type: 'UserMessage', content: ['completed prompt', { text: 'direct' }] } } })]
  for (const line of lines) {
    await ordinary.consumeLine(line)
    await selected.consumeLine(line)
  }
  const expected = await ordinary.finalize(process.platform)
  expect(await selected.finalize(process.platform)).toEqual(
    expected ? { ...expected, contentCoverage: 'partial' } : null
  )
})

it('delivers cancellation while tokenizing one near-limit selected string', async () => {
  const controller = new AbortController()
  const pending = decodeSessionListRecord('claude', JSON.stringify({ type: 'user',
    message: { content: 'x'.repeat(9 * 1024 * 1024) } }), controller.signal)
  const abort = setImmediate(() => controller.abort())
  try {
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  } finally {
    clearImmediate(abort)
  }
})
