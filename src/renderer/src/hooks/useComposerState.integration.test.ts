// @vitest-environment happy-dom

import { createElement } from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { EMPTY_RETIRED_NAME_REGISTRY } from '../../../shared/worktree/retired-name-registry'
import type { Repo } from '../../../shared/repo-types'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import { normalizeTaskSourceContext } from '../../../shared/task-source-context'
import { useComposerState } from './useComposerState'
import * as publicComposerDecisions from './useComposerState'
import * as composerDecisions from './composer-state/composer-decisions'

import NewWorkspaceComposerModal from '@/components/NewWorkspaceComposerModal'
import NewWorkspaceComposerCard from '@/components/NewWorkspaceComposerCard'
import { toast } from 'sonner'
import * as creationExecution from '@/lib/worktree-creation-flow-execute'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { getWorktreeLineageSelection } from '../../../shared/sidebar-list/worktree-lineage-projection'
import { getDefaultRepoHookSettings, getDefaultSettings } from '../../../shared/constants'
import {
  COMPOSER_CREATE_HANDOFF_DELAY_MS,
  COMPOSER_CREATE_PREPARE_DEADLINE_MS
} from '@/lib/composer-create-handoff'

vi.mock('@/components/NewWorkspaceComposerCard', () => ({ default: vi.fn(() => null) }))
vi.mock('@/components/agent/AgentSettingsDialog', () => ({ default: () => null }))

const initialStore = useAppStore.getState()
let originalApiDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')
  const preflight = {
    detectAgents: vi.fn<Window['api']['preflight']['detectAgents']>().mockResolvedValue([])
  } satisfies Pick<Window['api']['preflight'], 'detectAgents'>
  const worktrees = {
    listRetiredNames: vi
      .fn<Window['api']['worktrees']['listRetiredNames']>()
      .mockResolvedValue(EMPTY_RETIRED_NAME_REGISTRY)
  } satisfies Pick<Window['api']['worktrees'], 'listRetiredNames'>
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { preflight, worktrees }
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialStore, true)
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

describe('useComposerState integrated lifecycle', () => {
  it('keeps the public composer decisions bound to the canonical decision module', () => {
    expect(publicComposerDecisions.canResolveFolderSmartGitHubSubmit).toBe(
      composerDecisions.canResolveFolderSmartGitHubSubmit
    )
    expect(publicComposerDecisions.getInitialAutoManagedWorkspaceName).toBe(
      composerDecisions.getInitialAutoManagedWorkspaceName
    )
    expect(publicComposerDecisions.getInitialGitHubPrStartPointSelection).toBe(
      composerDecisions.getInitialGitHubPrStartPointSelection
    )
    expect(publicComposerDecisions.getMatchingLinkedTaskSourceContext).toBe(
      composerDecisions.getMatchingLinkedTaskSourceContext
    )
    expect(publicComposerDecisions.isExplicitWorkspaceNameInput).toBe(
      composerDecisions.isExplicitWorkspaceNameInput
    )
    expect(publicComposerDecisions.resolveInitialWorkspaceRunSeed).toBe(
      composerDecisions.resolveInitialWorkspaceRunSeed
    )
    expect(publicComposerDecisions.resolveSmartGitHubCreateNames).toBe(
      composerDecisions.resolveSmartGitHubCreateNames
    )
    expect(publicComposerDecisions.retargetGitHubPrStartPointSelection).toBe(
      composerDecisions.retargetGitHubPrStartPointSelection
    )
  })

  it('passes the selected runtime repository to the name field when IDs repeat across hosts', () => {
    const localRepo: Repo = {
      id: 'same-id',
      path: '/local',
      displayName: 'Local',
      badgeColor: '',
      addedAt: 0,
      defaultJiraProject: { id: '10', key: 'LOC', name: 'Local', siteId: 'site-a' }
    }
    const runtimeRepo: Repo = {
      ...localRepo,
      path: '/remote',
      executionHostId: 'runtime:remote',
      defaultJiraProject: { id: '20', key: 'REM', name: 'Remote', siteId: 'site-b' }
    }
    const projection = projectHostSetupProjectionFromRepos([localRepo, runtimeRepo])
    useAppStore.setState({
      repos: [localRepo, runtimeRepo],
      projects: [...projection.projects],
      projectHostSetups: projection.setups.map((setup) => ({
        ...setup,
        id: `${setup.hostId}:setup`
      })),
      projectGroups: [],
      newWorkspaceDraft: null,
      worktreesByRepo: {},
      sparsePresetsByRepo: {},
      runtimeEnvironments: [
        {
          id: 'remote',
          name: 'Remote',
          createdAt: 0,
          updatedAt: 0,
          lastUsedAt: null,
          runtimeId: null,
          endpoints: [],
          preferredEndpointId: 'endpoint'
        }
      ]
    })
    const composer = renderHook(() =>
      useComposerState({
        persistDraft: false,
        initialTaskSourceContext: normalizeTaskSourceContext({
          provider: 'jira',
          projectId: 'repo:same-id',
          hostId: 'runtime:remote'
        })
      })
    )
    expect(composer.result.current.cardProps.selectedRepo).toBe(runtimeRepo)
    expect(composer.result.current.cardProps.smartNameJiraSourceContext?.hostId).toBe(
      'runtime:remote'
    )
    composer.unmount()
  })

  it('composes two live composers and exposes the parent-worktree control state', () => {
    useAppStore.setState({
      repos: [],
      projects: [],
      projectGroups: [],
      projectHostSetups: [],
      newWorkspaceDraft: null,
      worktreesByRepo: {},
      sparsePresetsByRepo: {}
    })
    const first = renderHook(() => useComposerState({ initialName: 'first', persistDraft: false }))
    const second = renderHook(() =>
      useComposerState({ initialName: 'second', persistDraft: false })
    )

    expect(first.result.current.cardProps.name).toBe('first')
    expect(second.result.current.cardProps.name).toBe('second')
    expect(first.result.current.cardProps.parentWorktreeId).toBeNull()
    expect(first.result.current.cardProps.onParentWorktreeIdChange).toBeTypeOf('function')
    act(() => first.result.current.cardProps.onParentWorktreeIdChange('repo-1::/parent'))
    expect(first.result.current.cardProps.parentWorktreeId).toBe('repo-1::/parent')
    expect(first.result.current.cardProps.onNativeFileDrop).toBeUndefined()
    expect(second.result.current.cardProps.onNativeFileDrop).toBeUndefined()

    second.unmount()
    first.unmount()
  })
  it('reopens the actual modal with its selected parent and creation target after focus moves', async () => {
    vi.useFakeTimers()
    const execute = vi.spyOn(creationExecution, 'executeWorktreeCreation').mockResolvedValue()
    const error = vi.spyOn(toast, 'error').mockReturnValue('reopen-error')
    const noHooks = { hasHooks: false, hooks: null, mayNeedUpdate: false }
    const check = vi.fn<Window['api']['hooks']['check']>().mockResolvedValue(noHooks)
    const stalled = Promise.withResolvers<Awaited<ReturnType<typeof check>>>()
    check.mockReturnValueOnce(stalled.promise)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        hooks: { check },
        gh: {
          repoSlug: vi.fn().mockResolvedValue(null),
          listWorkItems: vi.fn<Window['api']['gh']['listWorkItems']>().mockResolvedValue({
            items: [],
            sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
          })
        },
        sparsePresets: { list: vi.fn().mockResolvedValue([]) }
      }
    })
    const localRepo: Repo = {
      id: 'reopen-repo',
      hookSettings: { ...getDefaultRepoHookSettings(), setupRunPolicy: 'ask' },
      path: '/local',
      displayName: 'Local',
      badgeColor: '',
      addedAt: 0
    }
    const remoteRepo: Repo = { ...localRepo, path: '/remote', executionHostId: 'runtime:remote' }
    const projection = projectHostSetupProjectionFromRepos([localRepo, remoteRepo])
    const parent = makeWorktree({
      id: 'reopen-repo::/local/parent',
      repoId: localRepo.id,
      path: '/local/parent',
      hostId: 'local',
      instanceId: 'parent-instance'
    })
    const parentToken = getWorktreeLineageSelection(parent)
    useAppStore.setState({
      repos: [localRepo, remoteRepo],
      projects: [...projection.projects],
      projectHostSetups: projection.setups.map((setup) => ({
        ...setup,
        id: `${setup.hostId}:setup`
      })),
      projectGroups: [],
      settings: { ...getDefaultSettings('/test'), defaultTuiAgent: 'blank' },
      newWorkspaceDraft: null,
      activeRepoId: localRepo.id,
      workspaceHostScope: 'local',
      worktreesByRepo: { [localRepo.id]: [parent] },
      sparsePresetsByRepo: {},
      pendingWorktreeCreations: {},
      runtimeEnvironments: [
        {
          id: 'remote',
          name: 'Remote',
          createdAt: 0,
          updatedAt: 0,
          lastUsedAt: null,
          runtimeId: null,
          endpoints: [],
          preferredEndpointId: 'endpoint'
        }
      ]
    })
    const card = () => {
      const props = vi.mocked(NewWorkspaceComposerCard).mock.calls.at(-1)?.[0]
      if (!props) {
        throw new Error('The actual modal did not render its composer card')
      }
      return props
    }
    act(() =>
      useAppStore.getState().openModal('new-workspace-composer', {
        initialRepoId: localRepo.id,
        prefilledName: 'reopen-child'
      })
    )
    render(createElement(NewWorkspaceComposerModal))
    const onParentWorktreeIdChange = card().onParentWorktreeIdChange
    if (!onParentWorktreeIdChange) {
      throw new Error('The composer card must expose parent selection')
    }
    act(() => onParentWorktreeIdChange(parentToken))
    expect(card().selectedRepoPath).toBe('/local')
    expect(card().createDisabled).toBe(false)
    await act(async () => {
      card().onCreate()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COMPOSER_CREATE_HANDOFF_DELAY_MS)
    })
    expect(useAppStore.getState().activeModal).toBe('none')
    expect(Object.values(useAppStore.getState().pendingWorktreeCreations)).toHaveLength(1)
    act(() => useAppStore.setState({ workspaceHostScope: 'runtime:remote' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COMPOSER_CREATE_PREPARE_DEADLINE_MS)
    })
    expect(execute).not.toHaveBeenCalled()
    const action = error.mock.calls.at(-1)?.[1]?.action
    if (!action || typeof action !== 'object' || !('onClick' in action)) {
      throw new Error('The real handoff did not offer Reopen')
    }
    render(createElement('button', { onClick: action.onClick }, 'Reopen'))
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    expect(card().parentWorktreeId).toBe(parentToken)
    expect(card().selectedRepoPath).toBe('/local')
    expect(card().selectedRepoExecutionHostId).toBe('local')
    await act(async () => {
      stalled.resolve(noHooks)
    })
    expect(execute).not.toHaveBeenCalled()
    await act(async () => {
      card().onCreate()
    })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][1]).toMatchObject({
      parentWorktreeId: parentToken,
      workspaceRunContext: {
        projectId: 'repo:reopen-repo',
        hostId: 'local',
        projectHostSetupId: 'local:setup',
        repoId: localRepo.id,
        path: '/local'
      }
    })
    expect(useAppStore.getState().worktreesByRepo[localRepo.id]).toContain(parent)
  })
})
