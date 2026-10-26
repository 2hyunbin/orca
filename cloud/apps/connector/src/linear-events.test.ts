import { describe, expect, it } from 'vitest'
import { readLinearEnvelope } from './linear-events.js'

// Shapes follow AgentSessionEventWebhookPayload, AgentSessionWebhookPayload and
// AgentActivityWebhookPayload in Linear's SDK schema
// (https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql) and the
// created/prompted description at https://linear.app/developers/agent-interaction. Ids are made up.
const session = {
  id: 'session-1',
  appUserId: 'app-user-1',
  organizationId: 'org-1',
  creatorId: 'user-1',
  creator: {
    id: 'user-1',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    url: 'https://linear.app/example/profiles/ada'
  },
  issueId: 'issue-1',
  issue: {
    id: 'issue-1',
    identifier: 'ENG-123',
    title: 'Fix accessibility on checkout page',
    description: 'Buttons lack labels.',
    url: 'https://linear.app/example/issue/ENG-123',
    teamId: 'team-1',
    team: { id: 'team-1', key: 'ENG', name: 'Engineering' }
  },
  commentId: 'comment-1',
  comment: { id: 'comment-1', body: '@orca please implement this', userId: 'user-1' },
  status: 'pending',
  type: 'commentThread',
  url: 'https://linear.app/example/issue/ENG-123#agent-session-1',
  createdAt: '2026-10-26T12:00:00.000Z',
  updatedAt: '2026-10-26T12:00:00.000Z'
}
const envelope = {
  type: 'AgentSessionEvent',
  organizationId: 'org-1',
  appUserId: 'app-user-1',
  oauthClientId: 'client-1',
  webhookId: 'webhook-1',
  webhookTimestamp: 1_800_000_000_000,
  createdAt: '2026-10-26T12:00:00.000Z',
  agentSession: session
}
const created = {
  ...envelope,
  action: 'created',
  promptContext:
    '<issue identifier="ENG-123">\n<title>Fix accessibility on checkout page</title>\n</issue>',
  previousComments: [{ id: 'comment-0', body: 'Earlier note', userId: 'user-2' }],
  guidance: [{ body: 'Always follow coding standards', origin: { type: 'team' } }]
}
const prompted = (activity: Record<string, unknown> = {}) => ({
  ...envelope,
  action: 'prompted',
  agentActivity: {
    id: 'activity-1',
    agentSessionId: 'session-1',
    content: { type: 'prompt', body: 'Also update the tests' },
    userId: 'user-2',
    user: { id: 'user-2', name: 'Grace Hopper', email: 'grace@example.com', url: 'u' },
    createdAt: '2026-10-26T12:01:00.000Z',
    updatedAt: '2026-10-26T12:01:00.000Z',
    ...activity
  }
})

const expectedSession = {
  id: 'session-1',
  organizationId: 'org-1',
  appUserId: 'app-user-1',
  creator: { id: 'user-1', name: 'Ada Lovelace' },
  issue: {
    id: 'issue-1',
    identifier: 'ENG-123',
    title: 'Fix accessibility on checkout page',
    description: 'Buttons lack labels.',
    url: 'https://linear.app/example/issue/ENG-123',
    teamId: 'team-1'
  },
  commentId: 'comment-1',
  url: 'https://linear.app/example/issue/ENG-123#agent-session-1'
}

describe('readLinearEnvelope', () => {
  it('reads a created session with its context and earlier comments', () => {
    expect(readLinearEnvelope(created)).toEqual({
      kind: 'event',
      event: {
        kind: 'created',
        session: expectedSession,
        promptContext: created.promptContext,
        previousComments: [{ id: 'comment-0', body: 'Earlier note', userId: 'user-2' }]
      }
    })
  })

  it('reads a session started by automation as having no creator', () => {
    const automated = {
      ...created,
      agentSession: { ...session, creatorId: null, creator: null, comment: null, commentId: null },
      promptContext: null,
      previousComments: undefined
    }
    const result = readLinearEnvelope(automated)
    expect(result.kind === 'event' && result.event).toMatchObject({
      kind: 'created',
      session: { creator: null, commentId: null },
      promptContext: '',
      previousComments: []
    })
  })

  it('reads a prompt with its author, from content.body or the documented body field', () => {
    expect(readLinearEnvelope(prompted())).toEqual({
      kind: 'event',
      event: {
        kind: 'prompted',
        session: expectedSession,
        activity: {
          id: 'activity-1',
          author: { id: 'user-2', name: 'Grace Hopper' },
          body: 'Also update the tests',
          stop: false
        }
      }
    })
    const bodyOnly = prompted({ content: { type: 'prompt' }, body: 'From the body field' })
    const result = readLinearEnvelope(bodyOnly)
    expect(
      result.kind === 'event' && result.event.kind === 'prompted' && result.event.activity.body
    ).toBe('From the body field')
  })

  it('reads the stop signal', () => {
    const result = readLinearEnvelope(
      prompted({ signal: 'stop', content: { type: 'prompt', body: '' } })
    )
    expect(
      result.kind === 'event' && result.event.kind === 'prompted' && result.event.activity
    ).toEqual({
      id: 'activity-1',
      author: { id: 'user-2', name: 'Grace Hopper' },
      body: '',
      stop: true
    })
  })

  it('ignores other webhooks and actions, and refuses what is not a webhook', () => {
    expect(readLinearEnvelope({ type: 'PermissionChange', action: 'teamAccessChanged' })).toEqual({
      kind: 'ignored'
    })
    expect(readLinearEnvelope({ ...envelope, action: 'updated' })).toEqual({ kind: 'ignored' })
    expect(readLinearEnvelope({ ...envelope, action: 'prompted' })).toEqual({ kind: 'ignored' })
    expect(readLinearEnvelope([])).toEqual({ kind: 'invalid' })
    expect(readLinearEnvelope(null)).toEqual({ kind: 'invalid' })
  })
})
