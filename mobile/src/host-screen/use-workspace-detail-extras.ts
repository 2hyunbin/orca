import { useEffect, useState } from 'react'
import type { HostedReviewInfo } from '../../../src/shared/hosted-review'
import { fetchHostedReviewForBranch } from '../session/github-pr-rpc'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import {
  buildWorkspaceDetailLinks,
  readWorkspaceDetailPorts,
  type WorkspaceDetailPort,
  type WorkspaceOriginDetails
} from '../worktree/workspace-details-model'
import {
  workspaceOriginRead,
  workspacePortsScanRead
} from '../worktree/workspace-details-operations'
import type { Worktree } from '../worktree/workspace-list-types'

/** What the long-press details read beyond the row; `undefined` while a read is still out. */
export type WorkspaceDetailExtras = {
  review?: HostedReviewInfo | null
  origin?: WorkspaceOriginDetails | null
  /** null: the host could not say (older host, unserved SSH host), which is not "no ports". */
  ports?: WorkspaceDetailPort[] | null
}

async function readReview(
  client: RpcOperationSender,
  worktreeId: string,
  branch: string,
  linkedGitHubPR: number | null
) {
  const outcome = await fetchHostedReviewForBranch(client, worktreeId, { branch, linkedGitHubPR })
  return outcome.ok ? outcome.result : null
}

async function readOrigin(client: RpcOperationSender, selector: string) {
  const verdict = workspaceOriginRead.interpret(
    await workspaceOriginRead.request(client, { worktree: selector })
  )
  return verdict.accepted ? verdict.value : null
}

async function readPorts(client: RpcOperationSender, selector: string, worktreeId: string) {
  const verdict = workspacePortsScanRead.interpret(
    await workspacePortsScanRead.request(client, { worktree: selector })
  )
  return verdict.accepted ? readWorkspaceDetailPorts(verdict.value, worktreeId) : null
}

/**
 * One workspace's details the row does not carry, read once when its long-press sheet opens and
 * only for sections the row says exist: the branch review's title and checks, who created it, and
 * its live ports. Each read is independent, so a slow or refused one leaves only its own section
 * at what the row says. `client` is the workspace's own host (the server for a server's row).
 */
export function useWorkspaceDetailExtras(
  row: Worktree | null,
  client: RpcOperationSender | null
): WorkspaceDetailExtras {
  const [extras, setExtras] = useState<{ key: string; value: WorkspaceDetailExtras } | null>(null)
  // Primitives, so a list refresh that replaces the row object does not read again.
  const worktreeId = row?.worktreeId ?? null
  const branch = row?.branch.replace(/^refs\/heads\//, '') ?? ''
  const linkedGitHubPR = row?.linkedPR?.number ?? null
  const readsReview =
    row !== null &&
    row.workspaceKind !== 'folder-workspace' &&
    buildWorkspaceDetailLinks(row).some((link) => link.type !== 'issue')
  const readsOrigin = Boolean(row?.automationCreated || row?.cliCreated)

  useEffect(() => {
    if (!worktreeId || !client) {
      return
    }
    let cancelled = false
    const merge = (patch: WorkspaceDetailExtras) => {
      if (!cancelled) {
        setExtras((current) => ({
          key: worktreeId,
          value: { ...(current?.key === worktreeId ? current.value : {}), ...patch }
        }))
      }
    }
    const selector = `id:${worktreeId}`
    if (readsReview) {
      void readReview(client, worktreeId, branch, linkedGitHubPR)
        .catch(() => null)
        .then((review) => merge({ review }))
    }
    if (readsOrigin) {
      void readOrigin(client, selector)
        .catch(() => null)
        .then((origin) => merge({ origin }))
    }
    void readPorts(client, selector, worktreeId)
      .catch(() => null)
      .then((ports) => merge({ ports }))
    return () => {
      cancelled = true
    }
  }, [worktreeId, client, branch, linkedGitHubPR, readsReview, readsOrigin])

  return extras && extras.key === worktreeId ? extras.value : {}
}
