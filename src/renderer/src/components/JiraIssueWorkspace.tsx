/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: Jira issue hydration, comments, transitions, priorities, and user options are loaded from provider IPC for the selected issue. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import * as VisuallyHidden from 'radix-ui/visually-hidden'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import {
  getCommentBodySubmitState,
  hasBoundedCommentBodyText
} from '@/lib/comment-body-submit-state'

import { createBrowserUuid } from '@/lib/browser-uuid'
import { useAppStore } from '@/store'
import {
  jiraAddIssueCommentForTarget,
  jiraGetIssueForTarget,
  jiraListAssignableUsersForTarget,
  jiraListPrioritiesForTarget,
  jiraUpdateIssueForTarget
} from '@/runtime/runtime-jira-client'
import type { JiraComment, JiraIssue, JiraPriority, JiraUser } from '../../../shared/jira-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import { JiraIssueMetadataBar, JiraIssueWorkspaceHeader } from './jira-issue-workspace-chrome'
import { JiraIssueCommentComposer, JiraIssueWorkspaceContent } from './jira-issue-workspace-content'
import { getJiraIssueWorkspaceActions } from './jira-issue-workspace-actions'
import { getJiraReadIdentity } from '@/store/slices/jira-read-coordination'
import { defaultScopeHost } from '@/lib/default-creation-host'
import { taskSourceRuntimeTarget } from '@/lib/task-source-runtime-target'
import {
  editedJiraIssueFields,
  mergeJiraIssueHydration,
  type EditableJiraIssueField
} from './jira-issue-workspace-hydration'
import { enqueueJiraIssueMutation, jiraIssueRequestScope } from './jira-issue-mutation-queue'
import { useJiraIssueComments } from './use-jira-issue-comments'
import { useJiraIssueMutationState } from './use-jira-issue-mutation-state'
import { useJiraIssueTransitions } from './use-jira-issue-transitions'

type JiraIssueWorkspaceProps = {
  issue: JiraIssue | null
  onUse: (issue: JiraIssue) => void
  onClose: () => void
  sourceContext?: TaskSourceContext | null
}

export default function JiraIssueWorkspace({
  issue,
  onUse,
  onClose,
  sourceContext
}: JiraIssueWorkspaceProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const owner = useMemo(
    () => (sourceContext ? taskSourceRuntimeTarget(sourceContext) : defaultScopeHost(settings)),
    [settings, sourceContext]
  )
  const mutationContextKey = getJiraReadIdentity(settings, sourceContext).contextKey
  const patchJiraIssue = useAppStore((s) => s.patchJiraIssue)
  const [fullIssue, setFullIssue] = useState<JiraIssue | null>(null)
  const [issueLoading, setIssueLoading] = useState(false)
  const [priorities, setPriorities] = useState<JiraPriority[]>([])
  const [users, setUsers] = useState<JiraUser[]>([])
  const [pendingField, setPendingField] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [labelsDraft, setLabelsDraft] = useState('')
  const [commentDraft, setCommentDraft] = useState('')
  const [commentSubmitting, setCommentSubmitting] = useState(false)
  const requestIdRef = useRef(0)
  const {
    comments,
    setComments,
    commentsLoading,
    setCommentsLoading,
    commentsError,
    setCommentsError,
    optimisticCommentsRef,
    loadComments
  } = useJiraIssueComments(owner, requestIdRef)
  const { transitions, setTransitions, loadTransitions } = useJiraIssueTransitions(
    owner,
    requestIdRef
  )

  const displayed = fullIssue ?? issue
  const siteId = displayed?.siteId ?? undefined
  // Cache patches replace the issue object without opening a different issue.
  const requestKey = jiraIssueRequestScope(issue, sourceContext, settings)
  const loadedRequestKeyRef = useRef<string | null>(null)
  const editedFieldsRef = useRef(new Set<EditableJiraIssueField>())

  // oxlint-disable-next-line react-doctor/no-derived-state-effect -- Why: seeds editable issue drafts while IPC hydration runs and invalidates obsolete requests.
  useEffect(() => {
    if (issue && loadedRequestKeyRef.current === requestKey) {
      return
    }
    loadedRequestKeyRef.current = requestKey
    requestIdRef.current += 1
    setPendingField(null)
    setCommentSubmitting(false)
    setCommentDraft('')
    if (!issue) {
      setFullIssue(null)
      setIssueLoading(false)
      setComments([])
      setCommentsLoading(false)
      setCommentsError(null)
      setTransitions([])
      setPriorities([])
      setUsers([])
      optimisticCommentsRef.current = []
      return
    }

    const requestId = requestIdRef.current
    optimisticCommentsRef.current = []
    editedFieldsRef.current = new Set()
    setFullIssue(issue)
    setTitleDraft(issue.title)
    setLabelsDraft(issue.labels.join(', '))
    setComments([])
    setCommentsError(null)
    setIssueLoading(true)

    void jiraGetIssueForTarget(owner, issue.key, issue.siteId)
      .then((result) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        if (result) {
          const edited = new Set(editedFieldsRef.current)
          setFullIssue((current) => mergeJiraIssueHydration(result, current, edited))
          if (!edited.has('title')) {
            setTitleDraft(result.title)
          }
          if (!edited.has('labels')) {
            setLabelsDraft(result.labels.join(', '))
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setIssueLoading(false)
        }
      })

    void Promise.all([
      jiraListPrioritiesForTarget(owner, issue.siteId),
      jiraListAssignableUsersForTarget(owner, issue.key, undefined, issue.siteId)
    ])
      .then(([nextPriorities, nextUsers]) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        setPriorities(nextPriorities)
        setUsers(nextUsers)
      })
      .catch(() => {})

    void loadTransitions(issue, requestId)
    void loadComments(issue, requestId)
  }, [
    issue,
    loadComments,
    loadTransitions,
    owner,
    requestKey,
    setComments,
    setCommentsError,
    setCommentsLoading,
    setTransitions,
    optimisticCommentsRef
  ])

  useJiraIssueMutationState({
    scope: requestKey,
    issue,
    displayed,
    editedFieldsRef,
    setFullIssue,
    setTitleDraft,
    setLabelsDraft,
    onStatusSettled: () => displayed && void loadTransitions(displayed, requestIdRef.current)
  })

  const mutateIssue = useCallback(
    async (
      field: string,
      updates: Parameters<typeof jiraUpdateIssueForTarget>[2],
      optimistic?: Partial<JiraIssue>
    ): Promise<void> => {
      if (!displayed || pendingField || !requestKey) {
        return
      }
      setPendingField(field)
      const previous = displayed
      const requestId = requestIdRef.current
      for (const editable of optimistic ? editedJiraIssueFields(optimistic) : []) {
        editedFieldsRef.current.add(editable)
      }
      try {
        await enqueueJiraIssueMutation({
          scope: requestKey,
          previous,
          optimistic: optimistic ?? {},
          update: () => jiraUpdateIssueForTarget(owner, previous.key, updates, siteId),
          refresh: () => jiraGetIssueForTarget(owner, previous.key, previous.siteId),
          patchIssue: (patch) =>
            patchJiraIssue(previous.key, patch, {
              sourceContext,
              siteId: previous.siteId,
              contextKey: mutationContextKey
            })
        })
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.JiraIssueWorkspace.ea21952aa3',
                'Failed to update Jira issue.'
              )
        )
      } finally {
        if (requestId === requestIdRef.current) {
          setPendingField(null)
        }
      }
    },
    [
      displayed,
      patchJiraIssue,
      pendingField,
      mutationContextKey,
      owner,
      requestKey,
      siteId,
      sourceContext
    ]
  )

  const handleSaveTitle = useCallback(() => {
    if (!displayed) {
      return
    }
    const title = titleDraft.trim()
    if (!title || title === displayed.title) {
      setTitleDraft(displayed.title)
      return
    }
    void mutateIssue('title', { title }, { title })
  }, [displayed, mutateIssue, titleDraft])

  const handleSaveLabels = useCallback(() => {
    if (!displayed) {
      return
    }
    const labels = labelsDraft
      .split(',')
      .map((label) => label.trim())
      .filter(Boolean)
    void mutateIssue('labels', { labels }, { labels })
  }, [displayed, labelsDraft, mutateIssue])

  const handleSubmitComment = useCallback(async (): Promise<void> => {
    if (!displayed || commentSubmitting) {
      return
    }
    const bodyState = getCommentBodySubmitState(commentDraft)
    if (bodyState.status === 'empty') {
      return
    }
    if (bodyState.status === 'too-large-leading-whitespace') {
      toast.error(
        translate(
          'auto.components.JiraIssueWorkspace.commentTooLarge',
          'Comment is too large to submit safely.'
        )
      )
      return
    }
    setCommentSubmitting(true)
    const requestId = requestIdRef.current
    try {
      const result = await jiraAddIssueCommentForTarget(
        owner,
        displayed.key,
        bodyState.body,
        displayed.siteId
      )
      if (!result.ok) {
        throw new Error(result.error)
      }
      if (requestId !== requestIdRef.current) {
        return
      }
      const comment: JiraComment = {
        id: result.id || createBrowserUuid(),
        body: bodyState.body,
        createdAt: new Date().toISOString(),
        user: { accountId: 'local', displayName: 'You' }
      }
      optimisticCommentsRef.current.push(comment)
      setComments((prev) => [...prev, comment])
      setCommentDraft('')
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate('auto.components.JiraIssueWorkspace.fa132c8aed', 'Failed to add comment.')
      )
    } finally {
      if (requestId === requestIdRef.current) {
        setCommentSubmitting(false)
      }
    }
  }, [commentDraft, commentSubmitting, displayed, owner, optimisticCommentsRef, setComments])

  const actionItems = useMemo(
    () => (displayed ? getJiraIssueWorkspaceActions(displayed) : []),
    [displayed]
  )

  return (
    <Sheet open={issue !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[min(92vw,780px)] p-0 sm:max-w-[780px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>
            {displayed?.title ??
              translate('auto.components.JiraIssueWorkspace.ef21405c6d', 'Jira issue')}
          </SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            {translate(
              'auto.components.JiraIssueWorkspace.857bd2f88f',
              'Preview, edit, and start work from the selected issue.'
            )}
          </SheetDescription>
        </VisuallyHidden.Root>

        {displayed ? (
          <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
            <JiraIssueWorkspaceHeader
              displayed={displayed}
              issueLoading={issueLoading}
              onUse={onUse}
              onClose={onClose}
            />

            <JiraIssueMetadataBar
              displayed={displayed}
              pendingField={pendingField}
              transitions={transitions}
              priorities={priorities}
              users={users}
              mutateIssue={mutateIssue}
            />

            <JiraIssueWorkspaceContent
              displayed={displayed}
              titleDraft={titleDraft}
              setTitleDraft={setTitleDraft}
              labelsDraft={labelsDraft}
              setLabelsDraft={setLabelsDraft}
              handleSaveTitle={handleSaveTitle}
              handleSaveLabels={handleSaveLabels}
              pendingField={pendingField}
              comments={comments}
              commentsError={commentsError}
              commentsLoading={commentsLoading}
              retryComments={() => void loadComments(displayed, requestIdRef.current)}
              onUse={onUse}
              actionItems={actionItems}
            />

            <JiraIssueCommentComposer
              commentDraft={commentDraft}
              setCommentDraft={setCommentDraft}
              commentSubmitting={commentSubmitting}
              canSubmitComment={hasBoundedCommentBodyText(commentDraft)}
              handleSubmitComment={() => void handleSubmitComment()}
            />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
