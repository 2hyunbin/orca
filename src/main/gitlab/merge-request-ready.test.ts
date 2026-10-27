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
})
