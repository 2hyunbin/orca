import { afterEach, describe, expect, it } from 'vitest'
import { CONTEXT_RETENTION_MS } from './connector-core.js'
import { saveIdentity } from './connector-identities.js'
import {
  cleanupConnectorHarnesses,
  createConnectorHarness
} from './connector-server-harness.test-fixture.js'
import { DiscordMembers } from './discord-members.js'

afterEach(cleanupConnectorHarnesses)

describe('DiscordMembers', () => {
  it('names only linked people, and forgets a name with the context it labelled', async () => {
    const { database, now, advance } = await createConnectorHarness()
    const members = new DiscordMembers(now)
    await saveIdentity(
      database,
      {
        source: 'discord',
        workspaceId: 'G1',
        userId: 'U1',
        accountId: 'user-1',
        defaultHostId: null,
        defaultProject: null,
        containerProjects: {}
      },
      now()
    )
    for (const userId of ['U1', 'U2']) {
      await members.remember(database, { guildId: 'G1', userId, userName: `name-${userId}` })
    }
    expect(await members.trustedNames(database, 'G1', ['U1', 'U2'])).toEqual(
      new Map([['U1', 'name-U1']])
    )
    advance(CONTEXT_RETENTION_MS + 1)
    await members.prune(database, CONTEXT_RETENTION_MS)
    expect(await members.trustedNames(database, 'G1', ['U1'])).toEqual(new Map())
  })
})
