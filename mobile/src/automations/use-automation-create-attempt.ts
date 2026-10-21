import { useCallback, useEffect, useRef } from 'react'
import { AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY } from '../../../src/shared/automation-runtime-capabilities'
import { randomV4Uuid } from '../platform/random-v4-uuid'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileAutomationRow } from './automation-reply-schema'
import { automationCreateWrite } from './automation-operations'
import { AUTOMATION_OUTCOME_UNKNOWN } from './automation-error'
import {
  automationCreateParams,
  newAutomationDraft,
  type AutomationDraft
} from './automation-draft'
import type { AutomationTargets } from './automation-target-inventory'

type SubmittedAutomationCreate = {
  params: ReturnType<typeof automationCreateParams>
  draft: AutomationDraft
  replyId?: string
}

export function useAutomationCreateAttempt(
  rows: readonly MobileAutomationRow[],
  creating: boolean,
  onReconcile: (row: MobileAutomationRow, initialDraft?: AutomationDraft) => void
) {
  const attempt = useRef<SubmittedAutomationCreate | null>(null)
  const latestDraft = useRef<AutomationDraft | null>(null)
  const observeDraft = useCallback((draft: AutomationDraft) => {
    latestDraft.current = draft
  }, [])
  useEffect(() => {
    const submitted = attempt.current
    if (!submitted || !creating) {
      return
    }
    const saved = rows.find((entry) =>
      submitted.params.creationKey
        ? entry.automation.creationKey === submitted.params.creationKey
        : entry.automation.id === submitted.replyId
    )
    if (!saved) {
      return
    }
    const current = latestDraft.current ?? submitted.draft
    const baseline = newAutomationDraft(saved.automation)
    const changes: Partial<AutomationDraft> = {}
    for (const key of [
      'name',
      'prompt',
      'agentId',
      'setupId',
      'workspaceId',
      'workspaceMode',
      'rrule',
      'timezone',
      'baseBranch',
      'setupDecision',
      'reuseSession',
      'extraAgentArgs',
      'precheckCommand',
      'precheckTimeout',
      'grace'
    ] as const) {
      if (current[key] !== submitted.draft[key]) {
        Object.assign(changes, { [key]: current[key] })
      }
    }
    attempt.current = null
    onReconcile(saved, Object.keys(changes).length ? { ...baseline, ...changes } : undefined)
  }, [rows, creating, onReconcile])
  return {
    observeDraft,
    reset: () => {
      attempt.current = null
      latestDraft.current = null
    },
    submit: async (
      client: RpcClient,
      draft: AutomationDraft,
      targets: AutomationTargets,
      capabilities: readonly string[]
    ) => {
      if (attempt.current && !attempt.current.params.creationKey) {
        throw new Error(AUTOMATION_OUTCOME_UNKNOWN)
      }
      const submitted: SubmittedAutomationCreate = attempt.current ?? {
        params: automationCreateParams(
          draft,
          targets,
          capabilities.includes(AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY)
            ? randomV4Uuid()
            : undefined
        ),
        draft: { ...draft }
      }
      attempt.current = submitted
      const result = automationCreateWrite.interpret(
        await automationCreateWrite.request(client, submitted.params, {
          failWhenDisconnected: true
        })
      )
      submitted.replyId = result.automation.id
    }
  }
}
