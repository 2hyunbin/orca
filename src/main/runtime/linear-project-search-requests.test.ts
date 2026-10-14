import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from '../linear/client'
import { loadLinearSdk } from '../linear/linear-sdk'
import {
  listProjects,
  listProjectsByExactName,
  type LinearProjectSearchPage
} from '../linear/linear-project-queries'
import { RuntimeLinearProjectWriteCommands } from './runtime-linear-project-write-commands'

const { getClients, clearToken } = vi.hoisted(() => ({
  getClients: vi.fn<() => LinearClientForWorkspace[]>(),
  clearToken: vi.fn()
}))
vi.mock('../linear/client', () => ({
  getClients,
  isAuthError: (error: unknown) => error instanceof loadLinearSdk().AuthenticationLinearError
}))
vi.mock('../linear/linear-token-store', () => ({ clearToken }))

const team = { id: 'team-1', workspaceId: 'workspace-1' }
const runtime = new RuntimeLinearProjectWriteCommands({
  runtimeAvailable: () => true,
  showTerminal: async () => {
    throw new Error('Unexpected terminal access')
  },
  resolveWorktreeSelector: async () => {
    throw new Error('Unexpected worktree access')
  },
  listResolvedWorktrees: async () => [],
  setWorktreeMeta: () => {},
  emitClientEvent: () => {}
})
const project = (id = 'project-1', teamId = 'team-1') => ({
  id,
  name: 'Launch',
  slugId: `${id}-slug`,
  description: 'Release project',
  teams: { nodes: [{ id: teamId, name: teamId, key: teamId }] }
})
const page = (nodes: ReturnType<typeof project>[], hasNextPage = false, endCursor?: string) => ({
  data: { searchProjects: { nodes, pageInfo: { hasNextPage, endCursor } } }
})
const requests: { operation: string; variables: Record<string, unknown> }[] = []
let apiKey = 'orca-offline-project-1'

function transport(reply: (operation: string, variables: Record<string, unknown>) => unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) !== 'https://api.linear.app/graphql' || typeof init?.body !== 'string') {
        throw new Error('Unexpected provider request')
      }
      const parsed = JSON.parse(init.body)
      const operation = /query\s+(\w+)/.exec(parsed.query)?.[1]
      const authorization = new Headers(init.headers).get('authorization') ?? ''
      if (
        !operation?.startsWith('OrcaLinear') ||
        !authorization.startsWith('orca-offline-project-')
      ) {
        throw new Error('Expected production read with offline credentials')
      }
      requests.push({ operation, variables: parsed.variables })
      const data = reply(operation, parsed.variables)
      return data instanceof Response
        ? data
        : new Response(JSON.stringify(data), {
            headers: { 'content-type': 'application/json' }
          })
    })
  )
}

async function firstPage() {
  const captured: { page?: LinearProjectSearchPage } = {}
  await listProjects('Launch', 50, team.workspaceId, true, (value) => {
    captured.page = value
  })
  if (!captured.page) {
    throw new Error('Missing first page')
  }
  return captured.page
}

beforeEach(() => {
  requests.length = 0
  clearToken.mockClear()
  apiKey = 'orca-offline-project-1'
  getClients.mockImplementation(() => [
    {
      workspace: {
        id: team.workspaceId,
        organizationId: 'org-1',
        organizationName: 'Example',
        displayName: 'Agent',
        email: null
      },
      client: new (loadLinearSdk().LinearClient)({ apiKey }),
      apiKey
    }
  ])
})
afterEach(() => vi.unstubAllGlobals())

describe('project name resolution through the shipping SDK', () => {
  it('resolves a trimmed exact name using one search', async () => {
    transport(() => page([project()]))
    await expect(runtime.resolveLinearCreateProject(' launch ', team)).resolves.toMatchObject({
      id: 'project-1',
      name: 'Launch',
      description: 'Release project',
      slugId: 'project-1-slug',
      workspaceId: team.workspaceId,
      workspaceName: 'Example',
      teams: [{ id: 'team-1', name: 'team-1', key: 'team-1' }]
    })
    expect(requests).toEqual([
      { operation: 'OrcaLinearProjectSearch', variables: { term: 'launch', first: 50 } }
    ])
  })

  it('rejects a second exact name found on a later page', async () => {
    transport((_operation, variables) =>
      variables.after ? page([project('project-2')]) : page([project()], true, 'cursor-1')
    )
    await expect(runtime.resolveLinearCreateProject('Launch', team)).rejects.toMatchObject({
      code: 'linear_invalid_project',
      data: { projects: [{ id: 'project-1' }, { id: 'project-2' }] }
    })
    expect(requests).toHaveLength(2)
    expect(requests.at(-1)?.variables).toEqual({ term: 'Launch', first: 50, after: 'cursor-1' })
  })

  it('still verifies team membership beyond the summary', async () => {
    transport((operation, variables) =>
      operation === 'OrcaLinearProjectSearch'
        ? page([project('project-1', 'other-team')])
        : {
            data: {
              project: {
                teams: {
                  nodes: [
                    { id: variables.after ? 'team-1' : 'other-team', name: 'Team', key: 'TM' }
                  ],
                  pageInfo: { hasNextPage: !variables.after, endCursor: 'team-cursor' }
                }
              }
            }
          }
    )
    await expect(runtime.resolveLinearCreateProject('Launch', team)).resolves.toMatchObject({
      id: 'project-1',
      teams: [{ id: 'other-team' }, { id: 'team-1' }]
    })
    expect(requests.map((request) => request.operation)).toEqual([
      'OrcaLinearProjectSearch',
      'OrcaLinearProjectTeams',
      'OrcaLinearProjectTeams'
    ])
  })

  it('retains auth failure and token clearing on a later page', async () => {
    transport((_operation, variables) =>
      variables.after
        ? new Response(
            JSON.stringify({
              errors: [
                {
                  message: 'Authentication required',
                  extensions: { code: 'AUTHENTICATION_ERROR', type: 'authentication error' }
                }
              ]
            }),
            { status: 401, headers: { 'content-type': 'application/json' } }
          )
        : page([project()], true, 'cursor-1')
    )
    await expect(runtime.resolveLinearCreateProject('Launch', team)).rejects.toMatchObject({
      code: 'linear_auth_expired'
    })
    expect(requests).toHaveLength(2)
    expect(clearToken.mock.calls).toEqual([[team.workspaceId]])
  })

  it.each([false, true])(
    'falls back when the page callback is absent or coalesced: %s',
    async (coalesced) => {
      transport(() => page([project()]))
      const captured: { page?: LinearProjectSearchPage } = {}
      const first = listProjects('Launch', 50, team.workspaceId)
      await (coalesced
        ? Promise.all([
            first,
            listProjects('Launch', 50, team.workspaceId, false, (value) => {
              captured.page = value
            })
          ])
        : first)
      expect(captured.page).toBeUndefined()
      await expect(
        listProjectsByExactName('Launch', team.workspaceId, true, captured.page)
      ).resolves.toMatchObject([{ id: 'project-1' }])
      expect(requests).toHaveLength(2)
    }
  )

  it.each([
    { term: 'Other' },
    { first: 20 },
    { workspaceId: 'workspace-2' },
    { apiKey: 'orca-offline-project-other' }
  ])('refetches an incompatible first page: %j', async (override) => {
    transport(() => page([project()]))
    const seed = {
      ...(await firstPage()),
      ...override,
      connection: page([project('stale')]).data.searchProjects
    }
    await expect(
      listProjectsByExactName('Launch', team.workspaceId, true, seed)
    ).resolves.toMatchObject([{ id: 'project-1' }])
    expect(requests).toHaveLength(2)
  })

  it('refetches when the credential rotates between resolver stages', async () => {
    transport(() => {
      const id = requests.length === 1 ? 'project-old' : 'project-new'
      apiKey = 'orca-offline-project-rotated'
      return page([project(id)])
    })
    await expect(runtime.resolveLinearCreateProject('Launch', team)).resolves.toMatchObject({
      id: 'project-new'
    })
    expect(requests).toHaveLength(2)
  })
})
