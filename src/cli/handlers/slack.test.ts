import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { formatReply, SLACK_HANDLERS } from './slack'

const call = vi.fn()
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reply handler calls only client.call.
const client = { call } as unknown as RuntimeClient

function context(): HandlerContext {
  return { client, cwd: process.cwd(), flags: new Map([['text', 'done']]), json: true, rawArgs: [] }
}

beforeEach(() => {
  vi.stubEnv('ORCA_PANE_KEY', 'tab:1')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  call.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('orca slack reply', () => {
  it('sends the calling pane and the text, and says where it went', async () => {
    call.mockResolvedValue({ result: { status: 'posted', messageTs: '1793.1' } })
    await SLACK_HANDLERS['slack reply'](context())
    expect(call).toHaveBeenCalledWith(
      'connector.reply',
      { paneKey: 'tab:1', replyId: expect.any(String), text: 'done' },
      { timeoutMs: 180_000 }
    )
    expect(formatReply({ status: 'posted' })).toBe('Posted to Slack.')
    expect(formatReply({ status: 'queued' })).toBe('Sent; Orca Cloud will post it to Slack.')
  })

  it('takes the pane from the scrub-safe alias when Claude scrubbed ORCA_PANE_KEY', async () => {
    vi.stubEnv('ORCA_PANE_KEY', '')
    vi.stubEnv('ORCA_AGENT_PANE', 'tab:2')
    call.mockResolvedValue({ result: { status: 'queued' } })
    await SLACK_HANDLERS['slack reply'](context())
    expect(call.mock.calls[0]?.[1]).toMatchObject({ paneKey: 'tab:2' })
  })

  it('passes a refusal through, and refuses outside an agent pane', async () => {
    call.mockRejectedValue(new RuntimeClientError('no_current_turn', 'no_current_turn'))
    await expect(SLACK_HANDLERS['slack reply'](context())).rejects.toMatchObject({
      code: 'no_current_turn'
    })
    expect(call).toHaveBeenCalledTimes(1)

    vi.stubEnv('ORCA_PANE_KEY', '')
    vi.stubEnv('ORCA_AGENT_PANE', '')
    await expect(SLACK_HANDLERS['slack reply'](context())).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })
})
