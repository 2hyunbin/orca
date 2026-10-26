import { ConnectorPollResponseSchema } from '@orca-cloud/connector-contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupConnectorHarnesses } from './connector-server-harness.test-fixture.js'
import {
  CHANNEL,
  conversation,
  EXTERNAL_ID,
  OWNER,
  startedThread,
  TEAMMATE,
  turnEnded,
  turnStarted
} from './slack-harness.test-fixture.js'

afterEach(async () => {
  await cleanupConnectorHarnesses()
  vi.unstubAllGlobals()
})

const CARD = `prompt:${EXTERNAL_ID}:p1`
const approval = (
  options = [
    { id: 'allow_once', label: 'Allow once' },
    { id: 'reject_once', label: 'Deny' }
  ]
) => ({
  kind: 'prompt',
  conversation,
  paneKey: 'pane-1',
  prompt: { kind: 'approval', promptId: 'p1', tool: 'Bash', summary: 'rm -rf <dist>', options }
})

// A started thread whose agent is working and now asks for approval; its card is in Slack.
async function asked(prompt: unknown = approval()) {
  const harness = await startedThread()
  await harness.machine.ack([{ deliveryId: harness.start?.deliveryId, step: 'received' }])
  await harness.events(turnStarted, prompt)
  await harness.pass()
  await harness.pass()
  const card = async () => {
    const [row] = await harness.database.query(
      'SELECT body, slack_ts FROM connector_slack_posts WHERE post_id = ?',
      [CARD]
    )
    return row
      ? { ...JSON.parse(String(row.body)), ts: row.slack_ts === null ? null : String(row.slack_ts) }
      : undefined
  }
  const deliveries = async () =>
    ConnectorPollResponseSchema.parse((await harness.machine.poll()).body).deliveries
  const ephemerals = async () =>
    (await harness.posts())
      .filter((post) => post.kind === 'ephemeral')
      .map((post) => [String(post.post_id), JSON.parse(String(post.body)).text])
  return { ...harness, card, deliveries, ephemerals }
}

describe('Slack prompt cards', () => {
  it('posts the prompt with a button per option, and says the answer is wanted here', async () => {
    const harness = await asked()
    expect(harness.fake.take('chat.postMessage').at(-1)?.args).toMatchObject({
      channel: CHANNEL,
      text: '*Bash* wants approval\nrm -rf &lt;dist&gt;',
      blocks: [
        { type: 'section' },
        {
          type: 'actions',
          elements: [
            { action_id: 'answer:0', text: { text: 'Allow once' }, value: 'allow_once' },
            { action_id: 'answer:1', text: { text: 'Deny' }, value: 'reject_once' }
          ]
        }
      ]
    })
    expect(await harness.status()).toBe('Waiting for your answer.')
  })

  it('sends the owner’s click to the machine once, and closes the card with their answer', async () => {
    const harness = await asked()
    const { ts } = await harness.card()
    expect((await harness.click({ messageTs: ts, value: 'reject_once' })).status).toBe(200)
    expect((await harness.click({ messageTs: ts, value: 'allow_once' })).status).toBe(200)
    expect(await harness.deliveries()).toEqual([
      expect.objectContaining({
        kind: 'answer',
        deliveryId: `answer:${EXTERNAL_ID}:p1`,
        promptId: 'p1',
        optionId: 'reject_once'
      })
    ])
    const card = await harness.card()
    expect(card.text).toBe(`<@${OWNER}> answered: Deny.`)
    expect(card.blocks.map((block: { type: string }) => block.type)).toEqual(['section', 'context'])
    expect(await harness.ephemerals()).toEqual([
      [`moved-on:${CARD}:${OWNER}`, 'Already answered or moved on.']
    ])
    // The machine's next report still shows the prompt: the answered card stays closed.
    await harness.events(approval())
    expect((await harness.card()).text).toBe(`<@${OWNER}> answered: Deny.`)
  })

  it('tells anyone but the owner, privately, that only the owner can answer', async () => {
    const harness = await asked()
    const { ts } = await harness.card()
    await harness.click({ user: TEAMMATE, messageTs: ts, value: 'allow_once' })
    expect(await harness.deliveries()).toEqual([])
    expect(await harness.ephemerals()).toEqual([
      [`only-owner:${CARD}:${TEAMMATE}`, `Only <@${OWNER}> can answer this.`]
    ])
    expect((await harness.card()).blocks).toHaveLength(2)
  })

  it('closes the card when the agent moves on, and a late click sends nothing', async () => {
    const harness = await asked()
    const { ts } = await harness.card()
    await harness.events(turnEnded)
    const card = await harness.card()
    expect(card.text).toBe('No longer waiting for this answer.')
    expect(card.blocks.map((block: { type: string }) => block.type)).toEqual(['section', 'context'])
    await harness.click({ messageTs: ts, value: 'allow_once' })
    expect(await harness.deliveries()).toEqual([])
    expect(await harness.ephemerals()).toEqual([
      [`moved-on:${CARD}:${OWNER}`, 'Already answered or moved on.']
    ])
  })

  it('reads an answer the agent no longer wanted as already answered, and one that never arrived as offline', async () => {
    const harness = await asked()
    const { ts } = await harness.card()
    await harness.click({ messageTs: ts, value: 'allow_once' })
    const [answer] = await harness.deliveries()
    await harness.machine.ack([
      {
        deliveryId: answer?.deliveryId,
        step: 'done',
        result: { outcome: 'refused', reason: 'prompt_not_pending' }
      }
    ])
    await harness.events(turnEnded)
    expect(await harness.status()).toBe('Already answered or moved on.')

    const offline = await asked()
    await offline.click({ messageTs: (await offline.card()).ts, value: 'allow_once' })
    offline.advance(5 * 60_000 + 1)
    await offline.runtime.inbox.expireDue(offline.edge.onExpired)
    expect(await offline.status()).toMatch(/^Couldn’t reach/)
  })

  it('leaves prompts Slack can’t answer to Orca: no card, the status says where', async () => {
    for (const prompt of [
      approval([{ id: 'allow_once', label: ' ' }]),
      approval([]),
      {
        ...approval(),
        prompt: {
          kind: 'question',
          promptId: 'p1',
          question: 'Which?',
          options: [{ id: 'a', label: 'A' }]
        }
      },
      { ...approval(), prompt: { kind: 'unsupported', promptId: 'p1' } }
    ]) {
      const harness = await asked(prompt)
      expect(await harness.card()).toBeUndefined()
      expect(await harness.status()).toBe('Waiting for your answer in Orca on build-box.')
    }
  })

  it('ignores a click on a message that isn’t a card, and refuses an unsigned one', async () => {
    const harness = await asked()
    expect(
      (await harness.click({ messageTs: '1800000999.000001', value: 'allow_once' })).status
    ).toBe(200)
    const response = await harness.request('/slack/interactivity', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'payload=%7B%7D'
    })
    expect(response.status).toBe(401)
    expect(await harness.deliveries()).toEqual([])
    expect(await harness.ephemerals()).toEqual([])
  })

  it('answers nothing while paused, and says so to the clicker', async () => {
    const harness = await asked()
    await harness.operator('pause', '--team', 'T1')
    await harness.click({ messageTs: (await harness.card()).ts, value: 'allow_once' })
    expect(await harness.deliveries()).toEqual([])
    expect((await harness.ephemerals()).map(([, text]) => text)).toEqual([
      'Orca for Slack is paused.'
    ])
  })
})
