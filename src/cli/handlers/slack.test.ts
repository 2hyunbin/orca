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
  vi.useFakeTimers()
  vi.stubEnv('ORCA_PANE_KEY', 'tab:1')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  call.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
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
      undefined
    )
    expect(formatReply({ status: 'posted' })).toBe('Posted to Slack.')
    expect(formatReply({ status: 'queued' })).toBe('Sent; Orca Cloud will post it to Slack.')
  })

  it('retries an unavailable connector with the same reply id, so it posts once', async () => {
    call
      .mockRejectedValueOnce(
        new RuntimeClientError('connector_unavailable', 'connector_unavailable')
      )
      .mockResolvedValueOnce({ result: { status: 'queued' } })
    const done = SLACK_HANDLERS['slack reply'](context())
    await vi.advanceTimersByTimeAsync(2_000)
    await done
    const [first, second] = call.mock.calls.map(([, params]) => params.replyId)
    expect(second).toBe(first)
  })

  it('does not retry a refusal, and refuses outside an agent pane', async () => {
    call.mockRejectedValue(new RuntimeClientError('no_current_turn', 'no_current_turn'))
    await expect(SLACK_HANDLERS['slack reply'](context())).rejects.toMatchObject({
      code: 'no_current_turn'
    })
    expect(call).toHaveBeenCalledTimes(1)

    vi.stubEnv('ORCA_PANE_KEY', '')
    await expect(SLACK_HANDLERS['slack reply'](context())).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })
})
