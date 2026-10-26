import { describe, expect, it } from 'vitest'
import {
  activityCreateRequest,
  createLinearGraphql,
  sessionUpdateRequest,
  type LinearRequest
} from './linear-graphql.js'

// Response shapes: https://linear.app/developers/rate-limiting (HTTP 400 + RATELIMITED, reset
// headers in UTC epoch ms) and https://linear.app/developers/agent-interaction (mutations).
const NOW = 1_800_000_000_000
const viewer: LinearRequest = { query: 'query { viewer { id } }', variables: {} }

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  const request = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
  }
  return { api: createLinearGraphql(request, () => NOW), calls }
}

const rateLimited = {
  errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }]
}

describe('createLinearGraphql', () => {
  it('posts the query with the bearer token and returns the data', async () => {
    const { api, calls } = respond(200, { data: { viewer: { id: 'app-user-1' } } })
    expect(await api('token-1', viewer)).toEqual({
      kind: 'ok',
      body: { viewer: { id: 'app-user-1' } }
    })
    expect(calls[0]?.url).toBe('https://api.linear.app/graphql')
    expect(calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer token-1' })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(viewer)
  })

  it('retries a rate limit after the spent window resets', async () => {
    const headers = {
      'x-ratelimit-requests-remaining': '0',
      'x-ratelimit-requests-reset': String(NOW + 30_000),
      'x-ratelimit-complexity-remaining': '1500000',
      'x-ratelimit-complexity-reset': String(NOW + 3_000_000)
    }
    expect(await respond(400, rateLimited, headers).api('t', viewer)).toEqual({
      kind: 'retry',
      afterMs: 30_000
    })
  })

  it('prefers Retry-After, reads the SDK’s error type, and retries without a known reset', async () => {
    expect(await respond(400, rateLimited, { 'retry-after': '7' }).api('t', viewer)).toEqual({
      kind: 'retry',
      afterMs: 7_000
    })
    const typed = { errors: [{ message: 'x', extensions: { type: 'ratelimited' } }] }
    expect(await respond(400, typed).api('t', viewer)).toEqual({ kind: 'retry' })
    expect(await respond(429, '').api('t', viewer)).toEqual({ kind: 'retry' })
  })

  it('fails on GraphQL errors and a refused token', async () => {
    const invalid = { errors: [{ message: 'bad', extensions: { type: 'invalid input' } }] }
    expect(await respond(400, invalid).api('t', viewer)).toEqual({
      kind: 'failed',
      error: 'invalid input'
    })
    expect(await respond(401, { errors: [{ message: 'no' }] }).api('t', viewer)).toEqual({
      kind: 'failed',
      error: 'authentication error'
    })
  })

  it('is unknown when the request may have reached Linear', async () => {
    expect(await respond(502, 'bad gateway').api('t', viewer)).toEqual({ kind: 'unknown' })
    expect(await respond(200, 'not json').api('t', viewer)).toEqual({ kind: 'unknown' })
    const failing = createLinearGraphql(async () => {
      throw new Error('socket hang up')
    })
    expect(await failing('t', viewer)).toEqual({ kind: 'unknown' })
  })
})

// Inputs follow AgentActivityCreateInput / AgentSessionUpdateInput in Linear's SDK schema and the
// examples at https://linear.app/developers/agent-signals.
describe('Linear agent requests', () => {
  const input = (request: LinearRequest) => request.variables.input

  it('builds thoughts, actions, responses and errors', () => {
    expect(
      input(activityCreateRequest('s1', 'a1', { type: 'thought', body: 'Sent', ephemeral: true }))
    ).toEqual({
      agentSessionId: 's1',
      id: 'a1',
      content: { type: 'thought', body: 'Sent' },
      ephemeral: true
    })
    expect(
      input(
        activityCreateRequest('s1', 'a1', {
          type: 'action',
          action: 'Ran',
          parameter: 'tests',
          result: 'ok'
        })
      )
    ).toEqual({
      agentSessionId: 's1',
      id: 'a1',
      content: { type: 'action', action: 'Ran', parameter: 'tests', result: 'ok' }
    })
    expect(input(activityCreateRequest('s1', 'a1', { type: 'response', body: 'Done' }))).toEqual({
      agentSessionId: 's1',
      id: 'a1',
      content: { type: 'response', body: 'Done' }
    })
    expect(input(activityCreateRequest('s1', 'a1', { type: 'error', body: 'Stopped' }))).toEqual({
      agentSessionId: 's1',
      id: 'a1',
      content: { type: 'error', body: 'Stopped' }
    })
  })

  it('builds select and auth elicitations as signals', () => {
    const options = [
      { label: 'frontend', value: 'src/packages/frontend' },
      { value: 'https://github.com/example/repo' }
    ]
    expect(
      input(
        activityCreateRequest('s1', 'a1', {
          type: 'elicitation',
          body: 'Which package?',
          select: options
        })
      )
    ).toEqual({
      agentSessionId: 's1',
      id: 'a1',
      content: { type: 'elicitation', body: 'Which package?' },
      signal: 'select',
      signalMetadata: { options }
    })
    const auth = { url: 'https://example.com/link', userId: 'user-1', providerName: 'Orca' }
    expect(
      input(
        activityCreateRequest('s1', 'a1', { type: 'elicitation', body: 'Link your account', auth })
      )
    ).toEqual({
      agentSessionId: 's1',
      id: 'a1',
      content: { type: 'elicitation', body: 'Link your account' },
      signal: 'auth',
      signalMetadata: auth
    })
  })

  it('replaces the session’s links and plan', () => {
    const request = sessionUpdateRequest('s1', {
      externalUrls: [{ label: 'Pull request', url: 'https://github.com/example/repo/pull/1' }],
      plan: [{ content: 'Write tests', status: 'inProgress' }]
    })
    expect(request.query).toContain('agentSessionUpdate(id: $id, input: $input)')
    expect(request.variables).toEqual({
      id: 's1',
      input: {
        externalUrls: [{ label: 'Pull request', url: 'https://github.com/example/repo/pull/1' }],
        plan: [{ content: 'Write tests', status: 'inProgress' }]
      }
    })
  })
})
