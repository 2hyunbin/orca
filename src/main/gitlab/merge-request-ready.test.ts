import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execute, release } = vi.hoisted(() => ({ execute: vi.fn(), release: vi.fn() }))
vi.mock('./gl-utils', () => ({
  acquire: vi.fn(),
  release,
  glabExecFileAsync: execute,
  glabHostnameArgs: () => ['--hostname', 'git.internal'],
  glabRepoExecOptions: () => ({ connectionId: 'ssh-1' }),
  classifyGlabError: (message: string) => ({ message })
}))
vi.mock('./merge-request-project-resolution', () => ({
  withProjectRef: async (
    _repo: string,
    _preference: unknown,
    _connection: unknown,
    _project: unknown,
    action: (project: { host: string; path: string }) => unknown
  ) => action({ host: 'git.internal', path: 'group/project' })
}))

import { updateMR } from './merge-request-update'

describe('GitLab readiness title ownership', () => {
  beforeEach(() => vi.clearAllMocks())

  it('preserves a concurrent web title edit when marking a draft ready', async () => {
    let title = 'Draft: Original title'
    execute.mockImplementation(async (args: string[]) => {
      if (args.includes('graphql')) {
        title = 'Draft: Concurrent web edit'
        title = title.replace(/^Draft: /, '')
        return {
          stdout: JSON.stringify({
            data: { mergeRequestSetDraft: { mergeRequest: { iid: '12' }, errors: [] } }
          })
        }
      }
      if (!args.includes('PUT')) {
        const snapshot = title
        title = 'Draft: Concurrent web edit'
        return { stdout: JSON.stringify({ title: snapshot }) }
      }
      const titleField = args.find((arg) => arg.startsWith('title='))
      if (titleField) {
        title = titleField.slice('title='.length)
      }
      return { stdout: '{}' }
    })

    await expect(
      updateMR('/repo', 12, { readyForReview: true }, undefined, 'ssh-1')
    ).resolves.toEqual({ ok: true })
    expect(title).toBe('Concurrent web edit')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][1]).toEqual({ connectionId: 'ssh-1' })
    expect(release).toHaveBeenCalledOnce()
  })

  it('keeps readiness combined with description and label updates working', async () => {
    execute.mockImplementation(async (args: string[]) => ({
      stdout: args.includes('graphql')
        ? JSON.stringify({
            data: { mergeRequestSetDraft: { mergeRequest: { iid: '12' }, errors: [] } }
          })
        : '{}'
    }))

    await expect(
      updateMR('/repo', 12, {
        readyForReview: true,
        body: 'Updated description',
        addLabels: ['review'],
        removeLabels: ['draft']
      })
    ).resolves.toEqual({ ok: true })
    expect(
      execute.mock.calls.some(([args]: [string[]]) =>
        args.includes('description=Updated description')
      )
    ).toBe(true)
    expect(
      execute.mock.calls.some(
        ([args]: [string[]]) =>
          args.includes('add_labels=review') && args.includes('remove_labels=draft')
      )
    ).toBe(true)
    expect(
      execute.mock.calls.every(
        ([args]: [string[]]) => !args.some((arg) => arg.startsWith('title='))
      )
    ).toBe(true)
  })

  it.each(['schema response', 'nonzero glab exit', 'absent endpoint'])(
    'preserves legacy readiness and combined metadata for an explicit %s',
    async (failure) => {
      const stdout = JSON.stringify({
        errors: [
          {
            message: "Field 'mergeRequestSetDraft' doesn't exist on type 'Mutation'",
            extensions: {
              code: 'undefinedField',
              typeName: 'Mutation',
              fieldName: 'mergeRequestSetDraft'
            }
          }
        ]
      })
      if (failure === 'schema response') {
        execute.mockResolvedValueOnce({ stdout })
      } else {
        execute.mockRejectedValueOnce(
          Object.assign(new Error('glab failed'), {
            stdout: failure === 'absent endpoint' ? '{"message":"404 Not Found"}' : stdout,
            stderr:
              failure === 'absent endpoint'
                ? 'glab: 404 Not Found (HTTP 404)'
                : 'glab: Field unsupported'
          })
        )
      }
      execute.mockResolvedValueOnce({ stdout: '{"title":"Draft: Current title"}' })
      execute.mockResolvedValueOnce({ stdout: '{}' })

      await expect(
        updateMR('/repo', 12, {
          readyForReview: true,
          body: 'Description',
          addLabels: ['review']
        })
      ).resolves.toEqual({ ok: true })
      expect(execute).toHaveBeenCalledTimes(3)
      expect(execute.mock.calls[1][0]).toEqual([
        'api',
        '--hostname',
        'git.internal',
        'projects/group%2Fproject/merge_requests/12'
      ])
      expect(execute.mock.calls[2][0]).toEqual([
        'api',
        '--hostname',
        'git.internal',
        '-X',
        'PUT',
        'projects/group%2Fproject/merge_requests/12',
        '-f',
        'title=Current title',
        '-f',
        'description=Description',
        '-f',
        'add_labels=review'
      ])
      expect(release).toHaveBeenCalledOnce()
    }
  )

  it.each([
    new Error('timeout while contacting GitLab'),
    Object.assign(new Error('unauthorized'), {
      stdout: '{"message":"401 Unauthorized"}',
      stderr: 'glab: HTTP 401'
    }),
    Object.assign(new Error('write outcome unknown'), {
      stdout: '{"data":{"mergeRequestSetDraft":{"mergeRequest":{"iid":"12"},"errors":[]}}}'
    })
  ])('does not fall back or accept success after a failed command: %s', async (error) => {
    execute.mockRejectedValueOnce(error)
    await expect(updateMR('/repo', 12, { readyForReview: true })).resolves.toMatchObject({
      ok: false
    })
    expect(execute).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
  })
})
