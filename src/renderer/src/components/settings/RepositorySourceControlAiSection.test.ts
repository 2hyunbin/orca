// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import './settings-persistence-test-fixture'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { normalizeRepoSourceControlAiOverrides } from '../../../../shared/source-control-ai'
import type { SourceControlAiSettings } from '../../../../shared/source-control-ai-types'
import {
  SOURCE_CONTROL_ACTION_IDS,
  type SourceControlActionId
} from '../../../../shared/source-control-ai-actions'
import {
  computeActionDirtyById,
  dropRepoLegacyInstructionForAction
} from './repository-source-control-ai-draft'
import { RepositorySourceControlAiActionRows } from './RepositorySourceControlAiActionRows'
import { RepositorySourceControlAiEnablement } from './RepositorySourceControlAiEnablement'
import { SourceControlAiActionRecipeDefaults } from './SourceControlAiActionRecipeDefaults'
import { useAppStore } from '../../store'

describe('RepositorySourceControlAiEnablement', () => {
  it('describes repo enablement as Source Control AI action visibility', () => {
    const markup = renderToStaticMarkup(
      React.createElement(RepositorySourceControlAiEnablement, {
        value: false,
        source: { enabled: true } as SourceControlAiSettings,
        onChange: () => {}
      })
    )

    expect(markup).toContain('Show Source Control AI actions')
    expect(markup).toContain('Controls whether Source Control AI buttons are shown')
    expect(markup).toContain('separate features follows those features&#x27; settings')
    expect(markup).toContain('Show')
    expect(markup).not.toContain('Source Control AI enabled')
  })
})

describe('RepositorySourceControlAiActionRows', () => {
  it.each([true, false])(
    'waits for shared inventory before choosing launch editors (Codex chat=%s)',
    async (chat) => {
      useAppStore.getState().clearLocalDetectedAgents()
      const settings = useAppStore.getState().settings!
      const launchPreferences = {
        agentId: 'claude' as const,
        model: 'saved',
        options: { fastMode: 'false' }
      }
      const recipe = {
        agentId: null,
        launchPreferences,
        agentArgs: '--saved-cli',
        commandInputTemplate: 'kept-template'
      }
      const source = {
        ...settings.sourceControlAi!,
        enabled: true,
        actions: { fixCommitFailure: recipe }
      }
      const originalRecipe = JSON.stringify(recipe)
      let finish: (ids: string[]) => void = () => {}
      const detectAgents = vi.fn(
        () =>
          new Promise<string[]>((resolve) => {
            finish = resolve
          })
      )
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { preflight: { detectAgents } }
      })
      useAppStore.setState({
        settings: {
          ...settings,
          defaultTuiAgent: 'claude',
          nativeChatProviders: { claude: !chat, codex: chat },
          sourceControlAi: source
        },
        settingsSearchQuery: '',
        localDetectedAgentIdsByContext: {}
      })
      const ensure = vi.spyOn(useAppStore.getState(), 'ensureNativeDetectedAgents')
      const writeConfig = vi.fn()
      const onEdit = vi.fn()
      const view = render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(SourceControlAiActionRecipeDefaults, {
            config: source,
            defaultTuiAgent: 'claude',
            searchQuery: '',
            writeConfig
          }),
          React.createElement(RepositorySourceControlAiActionRows, {
            repoId: 'repo-1',
            repoAi: { actionOverrides: { fixCommitFailure: recipe } },
            source,
            defaultTuiAgent: 'claude',
            savingActionIds: {},
            actionDirtyById: computeActionDirtyById({}, {}, {}),
            onActionModeChange: onEdit,
            onActionAgentChange: onEdit,
            onActionLaunchPreferencesChange: onEdit,
            onActionTemplateChange: onEdit,
            onActionAgentArgsChange: onEdit,
            onAppendVariable: onEdit,
            onActionDiscard: onEdit,
            onActionSave: onEdit
          })
        )
      )
      const cards = Array.from(view.container.querySelectorAll('textarea'))
        .filter((field) => field.value === 'kept-template')
        .map((field) => field.parentElement!.closest('.rounded-md')!)
      expect(cards).toHaveLength(2)
      expect(ensure).toHaveBeenCalledTimes(2)
      expect(detectAgents).toHaveBeenCalledTimes(1)
      for (const card of cards) {
        expect(card.textContent).not.toContain('CLI arguments')
        expect(card.textContent).not.toContain('Model')
        expect(card.querySelector('input')).toBeNull()
        expect(card.querySelector('[aria-hidden="true"] .h-8')).not.toBeNull()
      }
      await act(async () => {
        finish(['codex'])
      })
      for (const card of cards) {
        expect(card.textContent?.includes('Model')).toBe(chat)
        expect(card.textContent?.includes('Agent default')).toBe(chat)
        expect(card.textContent?.includes('CLI arguments')).toBe(!chat)
        expect(card.querySelector('input')?.value).toBe(chat ? undefined : '--saved-cli')
        expect(card.querySelector('textarea')?.value).toBe('kept-template')
      }
      expect(JSON.stringify(source.actions.fixCommitFailure)).toBe(originalRecipe)
      expect(writeConfig).not.toHaveBeenCalled()
      expect(onEdit).not.toHaveBeenCalled()
      expect(ensure).toHaveBeenCalledTimes(2)
    }
  )

  it('renders save controls on dirty repository action recipes', () => {
    const actionDirtyById = Object.fromEntries(
      SOURCE_CONTROL_ACTION_IDS.map((actionId) => [actionId, actionId === 'fixCommitFailure'])
    ) as Record<SourceControlActionId, boolean>
    const source = {
      enabled: true,
      agentId: null,
      selectedModelByAgent: {},
      selectedThinkingByModel: {},
      customAgentCommand: '',
      instructionsByOperation: {}
    } as SourceControlAiSettings

    const markup = renderToStaticMarkup(
      React.createElement(RepositorySourceControlAiActionRows, {
        repoId: 'repo-1',
        repoAi: {
          actionOverrides: {
            fixCommitFailure: {
              agentId: null,
              commandInputTemplate: '{basePrompt}\n\nrepo'
            }
          }
        },
        source,
        defaultTuiAgent: 'codex',
        savingActionIds: {},
        actionDirtyById,
        onActionModeChange: () => {},
        onActionAgentChange: () => {},
        onActionLaunchPreferencesChange: () => {},
        onActionTemplateChange: () => {},
        onActionAgentArgsChange: () => {},
        onAppendVariable: () => {},
        onActionDiscard: () => {},
        onActionSave: () => {}
      })
    )

    expect(markup).toContain('Commit failure fixes')
    expect(markup).toContain('Push failure fixes')
    expect(markup).toContain('Unsaved changes')
    expect(markup).toContain('Discard')
    expect(markup).toContain('Save')
    expect(markup).toContain('repo-repo-1-source-control-ai-fixCommitFailure')
  })
})

describe('dropRepoLegacyInstructionForAction', () => {
  it('prevents legacy text instructions from remigrating after an action override is cleared', () => {
    const next = dropRepoLegacyInstructionForAction(
      {
        instructionsByOperation: {
          commitMessage: 'Use repo style.',
          pullRequest: 'Use PR style.'
        },
        actionOverrides: {}
      },
      'commitMessage'
    )

    expect(next.instructionsByOperation).toEqual({ pullRequest: 'Use PR style.' })
    const normalized = normalizeRepoSourceControlAiOverrides(next)
    expect(normalized?.actionOverrides?.commitMessage).toBeUndefined()
    expect(normalized?.actionOverrides?.pullRequest).toEqual({
      commandInputTemplate: '{basePrompt}\n\nUse PR style.'
    })
  })

  it('leaves launch action recipes alone because they have no legacy instruction key', () => {
    const value = {
      instructionsByOperation: { commitMessage: 'Use repo style.' },
      actionOverrides: {
        fixChecks: { commandInputTemplate: '{basePrompt}' }
      }
    }

    expect(dropRepoLegacyInstructionForAction(value, 'fixChecks')).toBe(value)
  })
})
