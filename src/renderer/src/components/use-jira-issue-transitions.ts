import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { useCallback, useRef, useState, type RefObject } from 'react'
import { jiraListTransitionsForTarget } from '@/runtime/runtime-jira-client'
import type { JiraIssue, JiraTransition } from '../../../shared/jira-types'

export function useJiraIssueTransitions(
  owner: RuntimeClientTarget,
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
        const next = await jiraListTransitionsForTarget(owner, target.key, target.siteId)
        if (requestId === requestIdRef.current && readId === readIdRef.current) {
          setTransitions(next)
        }
      } catch {
        // Keep the current list if the reload fails.
      }
    },
    [owner, requestIdRef]
  )
  return { transitions, setTransitions, loadTransitions }
}
