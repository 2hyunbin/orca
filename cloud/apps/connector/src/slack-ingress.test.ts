import { ConnectorPollResponseSchema } from '@orca-cloud/connector-contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupConnectorHarnesses } from './connector-server-harness.test-fixture.js'
import {
  BOT,
  CHANNEL,
  createSlackHarness,
  OWNER,
  project,
  SIGNING_SECRET,
  TEAM,
  TEAMMATE
} from './slack-harness.test-fixture.js'

afterEach(async () => {
  await cleanupConnectorHarnesses()
  vi.unstubAllGlobals()
})

const THREAD = '1800000000.000100'
const EXTERNAL_ID = `${TEAM}:${CHANNEL}:${THREAD}:${OWNER}`

async function linkedOwner(slack: Partial<Parameters<typeof createSlackHarness>[0]> = {}) {
  const harness = await createSlackHarness(slack)
  await harness.operator(
    'link',
    '--team',
    TEAM,
    '--user',
    OWNER,
    '--account',
    'user-1',
    '--default-project',
    'orca'
  )
  const machine = await harness.machineWith('user-1', [project('orca', 'pl_orca', 'stablyai/orca')])
  const poll = async () => ConnectorPollResponseSchema.parse((await machine.poll()).body).deliveries
  return { ...harness, machine, poll }
}

const mention = (text = `<@${BOT}> fix the flaky test`) => ({ text, ts: THREAD })

describe('Slack event ingress', () => {
  it('answers url_verification and refuses a bad or stale signature', async () => {
    const harness = await createSlackHarness()
    const challenge = await harness.signedPost(
      JSON.stringify({ type: 'url_verification', challenge: 'abc' })
    )
    expect(await challenge.json()).toEqual({ challenge: 'abc' })

    const stale = await harness.signedPost('{}', Math.floor(harness.now() / 1000) - 301)
    expect(stale.status).toBe(401)
    const forged = await harness.request('/slack/events', {
      method: 'POST',
      headers: {
        'x-slack-request-timestamp': String(Math.floor(harness.now() / 1000)),
        'x-slack-signature': 'v0=00'
      },
      body: '{}'
    })
    expect(forged.status).toBe(401)
    expect(SIGNING_SECRET).toBeTruthy()
  })

  it('starts the owner’s conversation once for the message and app_mention twins', async () => {
    const harness = await linkedOwner()
    expect((await harness.message(mention())).status).toBe(200)
    expect((await harness.message({ ...mention(), type: 'app_mention' })).status).toBe(200)

    const deliveries = await harness.poll()
    expect(deliveries).toEqual([
      expect.objectContaining({
        kind: 'start',
        deliveryId: `${TEAM}:${CHANNEL}:${THREAD}`,
        conversation: { source: 'slack', externalId: EXTERNAL_ID },
        agent: 'claude',
        placeId: 'pl_orca',
        prompt: 'fix the flaky test'
      })
    ])
    expect((await harness.posts()).map((post) => [post.post_id, post.kind])).toEqual([
      [`eyes:${TEAM}:${CHANNEL}:${THREAD}`, 'reaction'],
      [`status:${EXTERNAL_ID}`, 'status']
    ])
  })

  it('ignores other workspaces, shared channels, edits, bots and plain chatter', async () => {
    const harness = await linkedOwner()
    await harness.message(mention(), { team_id: 'T9' })
    await harness.message(mention(), { is_ext_shared_channel: true })
    await harness.message({ ...mention(), subtype: 'message_changed' })
    await harness.message({ ...mention(), ts: '1800000000.000200', bot_id: 'B1' })
    await harness.message({ text: 'lunch?', ts: '1800000000.000300' })
    expect(await harness.poll()).toEqual([])
    expect(await harness.posts()).toEqual([])
  })

  it('sends the owner’s thread replies, and keeps teammates’ messages as context for the next one', async () => {
    const harness = await linkedOwner()
    await harness.message(mention())
    const [start] = await harness.poll()
    await harness.machine.ack([{ deliveryId: start?.deliveryId, step: 'received' }])

    await harness.message({
      user: TEAMMATE,
      text: 'also check CI',
      ts: '1800000000.000200',
      thread_ts: THREAD
    })
    expect(await harness.poll()).toEqual([])
    await harness.edge.worker.checkMembers()

    await harness.message({ text: 'go ahead', ts: '1800000000.000300', thread_ts: THREAD })
    const [send] = await harness.poll()
    expect(send).toMatchObject({ kind: 'send', conversation: { externalId: EXTERNAL_ID } })
    expect(send?.kind === 'send' ? send.text : '').toMatch(/\[Bob\] also check CI\n\ngo ahead$/)
  })

  it('leaves out a guest’s message', async () => {
    const harness = await linkedOwner()
    await harness.message(mention())
    const [start] = await harness.poll()
    await harness.machine.ack([{ deliveryId: start?.deliveryId, step: 'received' }])
    harness.fake.respond(
      'users.info',
      Response.json({ ok: true, user: { team_id: TEAM, is_restricted: true, name: 'guest' } })
    )
    await harness.message({
      user: TEAMMATE,
      text: 'rm -rf it',
      ts: '1800000000.000200',
      thread_ts: THREAD
    })
    await harness.edge.worker.checkMembers()
    await harness.message({ text: 'go ahead', ts: '1800000000.000300', thread_ts: THREAD })
    const [send] = await harness.poll()
    expect(send).toMatchObject({ kind: 'send', text: 'go ahead' })
  })

  it('gives a teammate who mentions Orca their own conversation', async () => {
    const harness = await linkedOwner()
    await harness.operator('link', '--team', TEAM, '--user', TEAMMATE, '--account', 'user-2')
    const theirs = await harness.machineWith('user-2', [project('orca', 'pl_theirs')])
    await harness.message(mention())
    await harness.message({
      user: TEAMMATE,
      text: `<@${BOT}> orca: what about docs`,
      ts: '1800000000.000200',
      thread_ts: THREAD
    })
    const [start] = ConnectorPollResponseSchema.parse((await theirs.poll()).body).deliveries
    expect(start).toMatchObject({
      kind: 'start',
      placeId: 'pl_theirs',
      conversation: { externalId: `${TEAM}:${CHANNEL}:${THREAD}:${TEAMMATE}` }
    })
  })

  it('answers an unlinked person, a person with no capable machine, and an unclear project', async () => {
    const harness = await createSlackHarness()
    await harness.message(mention())
    await harness.operator('link', '--team', TEAM, '--user', OWNER, '--account', 'user-1')
    await harness.message({ ...mention(), ts: '1800000000.000200' })
    await harness.machineWith('user-1', [project('orca'), project('web')])
    await harness.message({ ...mention(), ts: '1800000000.000300' })
    const bodies = (await harness.posts()).map((post) => [
      post.post_id,
      JSON.parse(String(post.body)).text
    ])
    expect(bodies).toEqual([
      [
        `ask:${TEAM}:${CHANNEL}:1800000000.000300`,
        expect.stringMatching(/^Which project\?.*\n• orca on build-box\n• web on build-box$/s)
      ],
      [`unlinked:${TEAM}:${CHANNEL}:${THREAD}`, expect.stringContaining('Ask an admin')],
      [`update:${TEAM}:${CHANNEL}:1800000000.000200`, expect.stringContaining('Update Orca')]
    ])
  })

  it('queues nothing while paused and says so once per thread', async () => {
    const harness = await linkedOwner({ paused: true })
    expect((await harness.message(mention())).status).toBe(200)
    await harness.message({ ...mention(), ts: '1800000000.000200', thread_ts: THREAD })
    expect(await harness.poll()).toEqual([])
    expect((await harness.posts()).map((post) => post.post_id)).toEqual([
      `paused:${TEAM}:${CHANNEL}:${THREAD}`
    ])
  })

  it('says the machine is offline when a message expires, and starts afresh on the next one', async () => {
    const harness = await linkedOwner()
    await harness.message(mention())
    harness.advance(5 * 60_000 + 1)
    await harness.edge.onExpired(await harness.runtime.inbox.expireDue())
    const posts = await harness.posts()
    expect(posts.map((post) => [post.post_id, JSON.parse(String(post.body)).text])).toEqual(
      expect.arrayContaining([
        [
          `offline:${EXTERNAL_ID}:${TEAM}:${CHANNEL}:${THREAD}`,
          'Your Orca on build-box is offline. Send again when it’s back.'
        ],
        [`status:${EXTERNAL_ID}`, 'Your Orca on build-box was offline.']
      ])
    )

    await harness.message({ text: 'try again', ts: '1800000000.000500', thread_ts: THREAD })
    const [retry] = await harness.poll()
    expect(retry).toMatchObject({ kind: 'start', placeId: 'pl_orca', prompt: 'try again' })
  })
})
