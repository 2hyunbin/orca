import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { openInMemoryConnectorDatabase } from './connector-database.js'
import { findIdentity } from './connector-identities.js'
import { SlackApps } from './slack-apps.js'
import { SlackInstalls } from './slack-installs.js'
import { runSlackOperator } from './slack-operator.js'

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

const SECRETS = { clientSecret: 'cs-1', signingSecret: 'ss-1', botToken: 'xoxb-1' }
const REGISTER = ['register-app', '--app-id', 'A1', '--client-id', '1.2', '--team', 'T1']

async function setup(stdin: string = JSON.stringify(SECRETS)) {
  const database = await openInMemoryConnectorDatabase()
  closers.push(() => database.close())
  const tokenKey = randomBytes(32)
  const run = (...argv: string[]) =>
    runSlackOperator(argv, { database, tokenKey, readSecret: async () => stdin, now: () => 1 })
  return { database, tokenKey, run }
}

describe('Slack operator command', () => {
  it('registers an app and its install sealed, and pauses or resumes the workspace', async () => {
    const { database, tokenKey, run } = await setup()
    expect(await run(...REGISTER, '--bot-user', 'UBOT')).toBe('Registered A1, installed in T1.')
    const rows = await database.query(
      `SELECT a.client_secret, a.signing_secret, i.bot_token FROM connector_slack_apps a
       JOIN connector_slack_installs i ON i.app_id = a.app_id`
    )
    expect(JSON.stringify(rows)).not.toMatch(/cs-1|ss-1|xoxb/)
    expect(await new SlackApps(tokenKey).signingSecret(database, 'A1')).toBe('ss-1')
    const installs = new SlackInstalls(tokenKey)
    expect(await installs.botToken(database, 'T1')).toBe('xoxb-1')
    expect(await run('pause', '--team', 'T1')).toBe('Paused T1.')
    expect(await installs.find(database, 'T1')).toEqual({
      teamId: 'T1',
      appId: 'A1',
      botUserId: 'UBOT',
      paused: true
    })
    await expect(run('resume', '--team', 'T2')).rejects.toThrow('T2 is not installed')
  })

  it('keeps one Orca app per workspace', async () => {
    const { database, tokenKey, run } = await setup()
    await run(...REGISTER, '--bot-user', 'UBOT')
    await expect(
      run('register-app', '--app-id', 'A2', '--client-id', '3.4', '--team', 'T1', '--bot-user', 'U2')
    ).rejects.toThrow('T1 already has another Orca app installed')
    // Refused as a whole: app 2 isn't kept either.
    expect(await new SlackApps(tokenKey).signingSecret(database, 'A2')).toBeNull()
    // Re-registering the same app updates it in place.
    await run(...REGISTER, '--bot-user', 'UBOT2')
    expect((await new SlackInstalls(tokenKey).find(database, 'T1'))?.botUserId).toBe('UBOT2')
  })

  it('refuses bad stdin without echoing it, and bad ids', async () => {
    const leaked = JSON.stringify({ ...SECRETS, botToken: 'xoxp-user-secret' })
    const refused = (await setup(leaked)).run(...REGISTER, '--bot-user', 'UBOT')
    await expect(refused).rejects.toThrow('stdin must be')
    await expect(refused).rejects.not.toThrow('xoxp-user-secret')
    await expect((await setup('not json')).run(...REGISTER, '--bot-user', 'UBOT')).rejects.toThrow(
      'stdin must be'
    )
    await expect(
      (await setup()).run('register-app', '--app-id', 'A1', '--client-id', 'x', '--team', 'T1', '--bot-user', 'U')
    ).rejects.toThrow('--client-id')
    await expect(
      (await setup()).run('register-app', '--app-id', 'A1', '--client-id', '1.2', '--team', 't1', '--bot-user', 'U')
    ).rejects.toThrow('--team')
  })

  it('links a Slack user to an account with machine-choice defaults', async () => {
    const { database, run } = await setup()
    await run(
      'link',
      '--team',
      'T1',
      '--user',
      'U1',
      '--account',
      'user-1',
      '--default-host',
      'user-1:machine',
      '--default-project',
      'stablyai/orca',
      '--channel-project',
      'C1=web'
    )
    expect(
      await findIdentity(database, { source: 'slack', workspaceId: 'T1', userId: 'U1' })
    ).toEqual({
      accountId: 'user-1',
      defaultHostId: 'user-1:machine',
      defaultProject: 'stablyai/orca',
      containerProjects: { C1: 'web' }
    })
    expect(await run('hosts', '--account', 'user-1')).toBe(
      'No machines have connected for this account.'
    )
  })
})
