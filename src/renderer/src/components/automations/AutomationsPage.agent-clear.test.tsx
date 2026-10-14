// @vitest-environment happy-dom

import { act } from 'react'
import { describe, expect, it } from 'vitest'
import {
  api,
  installAutomationsPageHarness,
  mocks,
  renderPage,
  scopedList,
  settleHostQueries
} from './automations-page-test-harness'
import {
  makeAutomation,
  makeAutomationListRow,
  REPO_ID,
  WORKSPACE_ID
} from './automations-page-fixtures'

installAutomationsPageHarness()

describe('automation agent clearing', () => {
  it.each(['create', 'edit'] as const)(
    'refuses to %s a draft with a cleared agent',
    async (mode) => {
      const automation = makeAutomation()
      api.automations.list.mockResolvedValue([automation])
      scopedList([automation])
      await renderPage()
      await settleHostQueries()
      await act(async () => {
        if (mode === 'edit') {
          mocks.listPanel?.openEditDialog(makeAutomationListRow({ automation }))
        } else {
          mocks.listPanel?.openCreateDialog()
        }
      })
      await act(async () => {
        mocks.editorDialog?.onDraftChange((current) => {
          if (typeof current !== 'object' || current === null) {
            throw new Error('Expected an automation draft')
          }
          return {
            ...current,
            name: 'Review',
            prompt: 'Review this project',
            projectId: REPO_ID,
            workspaceMode: 'existing',
            workspaceId: WORKSPACE_ID,
            agentId: null
          }
        })
      })
      await act(async () => {
        await mocks.editorDialog?.onSave()
      })
      expect(api.automations.create).not.toHaveBeenCalled()
      expect(api.automations.update).not.toHaveBeenCalled()
      expect(mocks.toastError).toHaveBeenCalledWith('Choose an enabled agent before saving.')
    }
  )
})
