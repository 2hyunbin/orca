import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { useCallback, useRef, useState, type RefObject } from 'react'
import { jiraIssueCommentsForTarget } from '@/runtime/runtime-jira-client'
import type { JiraComment, JiraIssue } from '../../../shared/jira-types'

export function useJiraIssueComments(owner: RuntimeClientTarget, requestIdRef: RefObject<number>) {
  const [comments, setComments] = useState<JiraComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsError, setCommentsError] = useState<string | null>(null)
  const optimisticCommentsRef = useRef<JiraComment[]>([])
  const loadComments = useCallback(
    async (targetIssue: JiraIssue, requestId: number): Promise<void> => {
      setCommentsLoading(true)
      setCommentsError(null)
      try {
        let fetched = await jiraIssueCommentsForTarget(owner, targetIssue.key, targetIssue.siteId)
        if (requestId !== requestIdRef.current) {
          return
        }
        const optimistic = optimisticCommentsRef.current
        if (optimistic.length > 0) {
          const fetchedIds = new Set(fetched.map((comment) => comment.id))
          fetched = [...fetched, ...optimistic.filter((comment) => !fetchedIds.has(comment.id))]
        }
        setComments(fetched)
      } catch (error) {
        if (requestId === requestIdRef.current) {
          setCommentsError(error instanceof Error ? error.message : 'Failed to load comments.')
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setCommentsLoading(false)
        }
      }
    },
    [owner, requestIdRef]
  )
  return {
    comments,
    setComments,
    commentsLoading,
    setCommentsLoading,
    commentsError,
    setCommentsError,
    optimisticCommentsRef,
    loadComments
  }
}
