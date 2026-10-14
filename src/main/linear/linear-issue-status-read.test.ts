import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { loadLinearSdk } from './linear-sdk'
import { getIssue } from './linear-issue-lookups'
import { getTeamStates } from './teams'
import { updateIssue } from './linear-issue-mutations'

const mocks = vi.hoisted(() => ({ getClients: vi.fn(), clearToken: vi.fn() }))
vi.mock('./client', () => {
  return {
    getClients: mocks.getClients,
    getPublicFileUrlClient: (_entry: unknown, signal: AbortSignal) =>
      new (loadLinearSdk().LinearClient)({ apiKey: 'offline', signal }),
    isAuthError: (error: unknown) => error instanceof loadLinearSdk().AuthenticationLinearError
  }
})
vi.mock('./linear-token-store', () => ({ clearToken: mocks.clearToken }))

const issue = {
  id: 'issue-1',
  identifier: 'ENG-1',
  title: 'Task',
  description: 'Work description',
  url: 'https://linear.app/acme/issue/ENG-1/task',
  updatedAt: '2026-10-10T12:00:00Z',
  priority: 1,
  labelIds: ['label-1'],
  state: { id: 'state-todo' },
  team: { id: 'team-1' },
  sharedAccess: { sharedWithUsers: [] },
  reactions: []
}
const workflowState = {
  id: 'state-review',
  name: 'In review',
  type: 'started',
  color: '',
  position: 1
}
const pageInfo = { hasNextPage: false, hasPreviousPage: false }
let populated = false
let failedOperation = ''
let authFailure = false
let operations: string[]
let writes: unknown[]

function responseData(operation: string): unknown {
  switch (operation) {
    case 'issue':
      return {
        issue: {
          ...issue,
          ...(populated
            ? {
                description: '![Screenshot](https://uploads.linear.app/workspace/image.png)',
                assignee: { id: 'user-1' },
                project: { id: 'project-1' }
              }
            : {})
        }
      }
    case 'workflowState':
      return {
        workflowState: { ...workflowState, id: 'state-todo', name: 'Todo', type: 'unstarted' }
      }
    case 'team':
      return { team: { id: 'team-1', name: 'Engineering', key: 'ENG' } }
    case 'issue_labels':
      return { issue: { labels: { nodes: [{ id: 'label-1', name: 'Bug' }], pageInfo } } }
    case 'issue_children':
      return {
        issue: { children: { nodes: populated ? [{ ...issue, id: 'child-1' }] : [], pageInfo } }
      }
    case 'user':
      return { user: { id: 'user-1', displayName: 'Example person' } }
    case 'project':
      return { project: { id: 'project-1', name: 'Project' } }
    case 'OrcaLinearDescriptionImages':
      return {
        issue: {
          description:
            '![Screenshot](https://uploads.linear.app/workspace/image.png?signature=offline)'
        }
      }
    case 'team_states':
      return { team: { states: { nodes: [workflowState], pageInfo } } }
    case 'updateIssue':
      return { issueUpdate: { success: true, issue: { id: 'issue-1' } } }
    default:
      throw new Error(`Unexpected SDK request: ${operation}`)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  populated = false
  failedOperation = ''
  authFailure = false
  operations = []
  writes = []
  mocks.getClients.mockImplementation((_workspaceId: unknown, signal: AbortSignal) => [
    {
      workspace: { id: 'workspace-1', organizationName: 'Workspace' },
      client: new (loadLinearSdk().LinearClient)({ apiKey: 'offline', signal })
    }
  ])
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      if (typeof init.body !== 'string') {
        throw new Error('Expected SDK JSON body')
      }
      const { query, variables } = JSON.parse(init.body)
      const operation = query.match(/\b(?:query|mutation)\s+(\w+)/)[1]
      operations.push(operation)
      if (operation === 'updateIssue') {
        writes.push(variables)
      }
      const body =
        operation === failedOperation
          ? {
              errors: [
                {
                  message: 'Read failed',
                  extensions: { type: authFailure ? 'authentication error' : 'forbidden' }
                }
              ]
            }
          : { data: responseData(operation) }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
  )
})
afterEach(() => vi.unstubAllGlobals())

it('removes two mandatory SDK requests from the board status read and write path', async () => {
  const run = async (statusOnly: boolean) => {
    const current = await getIssue('ENG-1', 'workspace-1', statusOnly)
    if (!current?.team.id) {
      throw new Error('Missing issue team')
    }
    const states = await getTeamStates(current.team.id, current.workspaceId)
    return updateIssue(current.id, { stateId: states[0].id }, current.workspaceId)
  }
  const fullResult = await run(false)
  expect(operations).toEqual([
    'issue',
    'workflowState',
    'team',
    'issue_labels',
    'issue_children',
    'team',
    'team_states',
    'updateIssue'
  ])
  operations = []
  await expect(run(true)).resolves.toEqual(fullResult)
  expect(fullResult).toEqual({ ok: true })
  expect(operations).toEqual([
    'issue',
    'workflowState',
    'team',
    'team',
    'team_states',
    'updateIssue'
  ])
  expect(writes).toEqual(
    Array.from({ length: 2 }, () => ({
      id: 'issue-1',
      input: { stateId: 'state-review' }
    }))
  )
})

it('preserves default display details and signed images while compact reads keep the same status', async () => {
  populated = true
  const full = await getIssue('ENG-1', 'workspace-1')
  expect(operations).toEqual([
    'issue',
    'workflowState',
    'team',
    'user',
    'project',
    'issue_labels',
    'issue_children',
    'OrcaLinearDescriptionImages'
  ])
  expect(full).toMatchObject({
    labels: ['Bug'],
    labelIds: ['label-1'],
    subIssues: [{ id: 'child-1' }],
    assignee: { id: 'user-1' },
    project: { id: 'project-1' },
    descriptionImageUrls: {
      'https://uploads.linear.app/workspace/image.png':
        'https://uploads.linear.app/workspace/image.png?signature=offline'
    }
  })
  operations = []
  const compact = await getIssue('ENG-1', 'workspace-1', true)
  expect(operations).toEqual(['issue', 'workflowState', 'team', 'OrcaLinearDescriptionImages'])
  expect(compact).toMatchObject({
    id: full?.id,
    identifier: full?.identifier,
    workspaceId: full?.workspaceId,
    state: full?.state,
    team: full?.team,
    descriptionImageUrls: full?.descriptionImageUrls
  })
})

it.each(['workflowState', 'team'])(
  'preserves the optional %s relation failure',
  async (operation) => {
    failedOperation = operation
    const full = await getIssue('ENG-1', 'workspace-1')
    const compact = await getIssue('ENG-1', 'workspace-1', true)
    expect(compact?.state).toEqual(full?.state)
    expect(compact?.team).toEqual(full?.team)
  }
)

it.each(['issue', 'OrcaLinearDescriptionImages'])(
  'preserves %s authentication errors and token clearing',
  async (operation) => {
    populated = true
    authFailure = true
    failedOperation = operation
    await expect(getIssue('ENG-1', 'workspace-1')).rejects.toBeInstanceOf(
      loadLinearSdk().AuthenticationLinearError
    )
    await expect(getIssue('ENG-1', 'workspace-1', true)).rejects.toBeInstanceOf(
      loadLinearSdk().AuthenticationLinearError
    )
    expect(mocks.clearToken.mock.calls).toEqual([['workspace-1'], ['workspace-1']])
  }
)
