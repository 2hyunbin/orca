import { useCallback, useRef, useState, type RefObject } from 'react'
import { jiraListTransitions } from '@/runtime/runtime-jira-client'
import type { JiraIssue, JiraTransition } from '../../../shared/jira-types'

export function useJiraIssueTransitions(
  providerSettings: Parameters<typeof jiraListTransitions>[0],
  requestIdRef: RefObject<number>
) {
  const [transitions, setTransitions] = useState<JiraTransition[]>([])
  const readIdRef = useRef(0)
  const loadTransitions = useCallback(
    async (target: JiraIssue, requestId: number): Promise<void> => {
      if (requestId !== requestIdRef.current) {
        return
      }
      const readId = ++readIdRef.current
      try {
        const next = await jiraListTransitions(providerSettings, target.key, target.siteId)
        if (requestId === requestIdRef.current && readId === readIdRef.current) {
          setTransitions(next)
        }
      } catch {
        // Keep the current list if the reload fails.
      }
    },
    [providerSettings, requestIdRef]
  )
  return { transitions, setTransitions, loadTransitions }
}
