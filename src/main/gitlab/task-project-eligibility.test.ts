import { beforeEach, describe, expect, it, vi } from 'vitest'

const { git, glab, gh } = vi.hoisted(() => ({ git: vi.fn(), glab: vi.fn(), gh: vi.fn() }))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: git,
  glabExecFileAsync: glab,
  ghExecFileAsync: gh
}))

import { listMergeRequests } from './merge-request-list'
import { listIssues } from './issues'
import { _resetProjectRefCache, _resetKnownHostsCache } from './gitlab-project-ref-resolution'
import { _resetRemoteNameListingCache } from '../git/remote-name-listing'

function serveRemotes(repos: Record<string, Record<string, string>>): void {
  git.mockImplementation(async (args: string[], options: { cwd: string }) => {
    const remotes = repos[options.cwd] ?? {}
    if (args[0] === 'remote' && args.length === 1) {
      return { stdout: Object.keys(remotes).join('\n') }
    }
    if (args[0] === 'remote' && args[1] === '-v') {
      return {
        stdout: Object.entries(remotes)
          .map(([name, url]) => `${name}\t${url} (fetch)`)
          .join('\n')
      }
    }
    if (args[0] === 'remote' && args[1] === 'get-url' && remotes[args[2]]) {
      return { stdout: remotes[args[2]] }
    }
    throw new Error(`No such remote: ${args.join(' ')}`)
  })
}

describe('GitLab task project admission', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    _resetProjectRefCache()
    _resetKnownHostsCache()
    _resetRemoteNameListingCache()
    gh.mockResolvedValue({ stdout: '' })
    serveRemotes({
      '/gitlab': { origin: 'git@gitlab.com:team/project.git' },
      '/github': { origin: 'git@github.com:team/project.git' }
    })
    glab.mockImplementation(async (args: string[]) => {
      if (args[0] === 'auth') {
        if (args.includes('github.com')) {
          throw new Error('No GitLab account for github.com')
        }
        return { stdout: 'gitlab.com\n  ✓ Logged in to gitlab.com\n' }
      }
      if (args[0] === 'api') {
        return { stdout: 'HTTP/2.0 200 OK\r\nX-Total: 0\r\nX-Total-Pages: 1\r\n\r\n[]' }
      }
      throw new Error('None of the git remotes correspond to the GITLAB_HOST environment variable')
    })
  })

  it.each(['mrs', 'issues'] as const)(
    'keeps an eligible empty %s list clean when the shared selection also contains GitHub',
    async (view) => {
      const list = view === 'mrs' ? listMergeRequests : listIssues
      const results = await Promise.allSettled(['/gitlab', '/github'].map((repo) => list(repo)))

      expect(results).toEqual([
        { status: 'fulfilled', value: expect.objectContaining({ items: [] }) },
        { status: 'fulfilled', value: expect.objectContaining({ items: [] }) }
      ])
      for (const result of results) {
        if (result.status === 'fulfilled') {
          expect(result.value.error).toBeUndefined()
        }
      }
      const listCalls = glab.mock.calls.filter(([args]) => args[0] !== 'auth')
      expect(listCalls).toHaveLength(1)
      expect(listCalls[0][0][0]).toBe('api')
      expect(listCalls[0][1]).toMatchObject({ cwd: '/gitlab' })
    }
  )

  it.each(['upstream', 'gitlab'])(
    'keeps a matching %s remote when origin is hosted on another forge',
    async (remoteName) => {
      serveRemotes({
        '/mixed': {
          origin: 'git@github.com:team/fork.git',
          [remoteName]: 'git@gitlab.com:group/project.git'
        }
      })

      const result = await listMergeRequests('/mixed')

      expect(result.error).toBeUndefined()
      expect(glab).toHaveBeenCalledWith(
        [
          'api',
          '-i',
          '--hostname',
          'gitlab.com',
          expect.stringContaining('projects/group%2Fproject/merge_requests?')
        ],
        { cwd: '/mixed' }
      )
    }
  )

  it.each([undefined, 'Ubuntu'])(
    'pins the admitted self-hosted HTTP port for MR and issue API lists (%s)',
    async (wslDistro) => {
      serveRemotes({ '/custom': { origin: 'https://gitlab.example.com:8443/group/project.git' } })
      const localGitOptions = wslDistro ? { wslDistro } : {}

      await listMergeRequests(
        '/custom',
        'opened',
        1,
        20,
        undefined,
        undefined,
        null,
        localGitOptions
      )
      await listIssues('/custom', 20, undefined, 'opened', undefined, null, localGitOptions)

      const lists = glab.mock.calls.filter(([args]) => args[0] === 'api')
      expect(lists).toHaveLength(2)
      for (const [args, options] of lists) {
        expect(args.slice(0, 4)).toEqual(['api', '-i', '--hostname', 'gitlab.example.com:8443'])
        expect(options).toEqual({ cwd: '/custom', ...localGitOptions })
      }
    }
  )

  it('never queries the old GitLab project after a warm WSL remote migrates to GitHub', async () => {
    serveRemotes({ '/migrating': { origin: 'git@gitlab.com:team/project.git' } })
    const options = { wslDistro: 'Ubuntu' }
    await listMergeRequests('/migrating', 'opened', 1, 20, undefined, undefined, null, options)
    glab.mockClear()
    serveRemotes({ '/migrating': { origin: 'git@github.com:team/project.git' } })

    const result = await listMergeRequests(
      '/migrating',
      'opened',
      1,
      20,
      undefined,
      undefined,
      null,
      options
    )

    expect(result.error).toBeUndefined()
    expect(result.items).toEqual([])
    expect(glab.mock.calls.filter(([args]) => args[0] !== 'auth')).toEqual([])
  })
})
