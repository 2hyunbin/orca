// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraProject } from '../../../shared/jira-types'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-client'
import { useJiraProjectInventory } from './use-jira-project-inventory'

const { status, projects } = vi.hoisted(() => ({ status: vi.fn(), projects: vi.fn() }))
vi.mock('@/runtime/runtime-jira-client', () => ({ jiraStatus: status, jiraListProjects: projects }))
afterEach(cleanup)
beforeEach(() => {
  status.mockReset()
  projects.mockReset()
  status.mockResolvedValue({ connected: true })
})

describe('Jira project inventory ownership', () => {
  it('ignores a late result from the previous account host', async () => {
    const local: RuntimeJiraSettings = { kind: 'local' }
    const remote: RuntimeJiraSettings = { kind: 'environment', environmentId: 'owner' }
    const localProject = { id: '10', key: 'ALP', name: 'Alpha', siteId: 'local-site' }
    const remoteProject = { ...localProject, siteId: 'remote-site' }
    let finishLocal: (value: JiraProject[]) => void = () => {
      throw new Error('Local request has not started')
    }
    projects.mockImplementation((source: RuntimeJiraSettings) =>
      source === local
        ? new Promise<JiraProject[]>((resolve) => {
            finishLocal = resolve
          })
        : Promise.resolve([remoteProject])
    )
    const initialProps: { source: RuntimeJiraSettings } = { source: local }
    const { result, rerender } = renderHook(({ source }) => useJiraProjectInventory(source, true), {
      initialProps
    })
    await waitFor(() => expect(projects).toHaveBeenCalledWith(local, 'all'))
    rerender({ source: remote })
    await waitFor(() => expect(result.current.projects).toEqual([remoteProject]))
    await act(async () => finishLocal([localProject]))
    expect(result.current.projects).toEqual([remoteProject])
  })

  it('does not discover projects when the account is disconnected', async () => {
    status.mockResolvedValue({ connected: false })
    const local: RuntimeJiraSettings = { kind: 'local' }
    const { result } = renderHook(() => useJiraProjectInventory(local, true))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.connected).toBe(false)
    expect(projects).not.toHaveBeenCalled()
  })
})
