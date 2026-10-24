import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { getKeepLocalMainUpToDateTitle } from '@/components/settings/keep-local-main-up-to-date-setting'
import { translate } from '@/i18n/i18n'
import { resolveWorktreeDisplayName } from '@/lib/worktree-default-display-name'
import type { AppState } from '@/store/types'
import type { LocalBaseRefRefreshResult } from '../../../../../../shared/worktree/base-ref-drift-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

export function localBaseRefRefreshFailureDetail(result: LocalBaseRefRefreshResult): string {
  const ownerWorktreePath = result.ownerWorktreePath?.trim()
  switch (result.status) {
    case 'skipped_dirty_worktree':
      // Create already succeeded — guide cleanup + manual base update, not "try again".
      return ownerWorktreePath
        ? translate(
            'auto.store.slices.worktrees.localBaseRefRefreshFailedDetailDirtyNamed',
            'The worktree at {{value0}} (where local {{value1}} is checked out) has uncommitted changes. Commit, stash, or discard those changes, then update local {{value1}} manually.',
            { value0: ownerWorktreePath, value1: result.localBranch }
          )
        : translate(
            'auto.store.slices.worktrees.localBaseRefRefreshFailedDetailDirty',
            'The worktree where local {{value0}} is checked out has uncommitted changes. Commit, stash, or discard those changes, then update local {{value0}} manually.',
            { value0: result.localBranch }
          )
    case 'skipped_not_fast_forward':
      return translate(
        'auto.store.slices.worktrees.localBaseRefRefreshFailedDetailNotFastForward',
        'Local {{value0}} does not exist or cannot be fast-forwarded cleanly from the remote base. Check for local-only commits before updating it manually.',
        { value0: result.localBranch }
      )
    case 'skipped_error':
      return translate(
        'auto.store.slices.worktrees.localBaseRefRefreshFailedDetailError',
        'Git returned an error while updating local {{value0}}. Check the repo for locked refs or unusual worktree state, then update local {{value0}} manually.',
        { value0: result.localBranch }
      )
    case 'updated':
      return ''
  }
}

/** `origin/main` → `git fetch --unshallow origin`; omits the remote when the base doesn't name one. */
function unshallowCommand(result: LocalBaseRefRefreshResult): string {
  const shortBaseRef = result.baseRef.replace(/^refs\/remotes\//, '')
  const suffix = `/${result.localBranch}`
  return shortBaseRef.endsWith(suffix) && shortBaseRef.length > suffix.length
    ? `git fetch --unshallow ${shortBaseRef.slice(0, -suffix.length)}`
    : 'git fetch --unshallow'
}

function refreshFailureTitle(result: LocalBaseRefRefreshResult, worktreeName: string): string {
  if (result.shallowHistory) {
    return translate(
      'auto.store.slices.worktrees.localBaseRefShallowHistoryTitle',
      'Local {{value0}} not updated: shallow clone',
      { value0: result.localBranch }
    )
  }
  return worktreeName
    ? translate(
        'auto.store.slices.worktrees.localBaseRefRefreshFailedForWorktree',
        'Local {{value0}} was not refreshed for "{{value1}}"',
        { value0: result.localBranch, value1: worktreeName }
      )
    : translate('auto.store.slices.worktrees.14bc053a47', 'Local {{value0}} was not refreshed', {
        value0: result.localBranch
      })
}

function refreshFailureDescription(
  result: LocalBaseRefRefreshResult,
  worktreeName: string
): React.ReactNode {
  if (result.shallowHistory) {
    const explanation = worktreeName
      ? translate(
          'auto.store.slices.worktrees.localBaseRefShallowHistoryNamed',
          '"{{value0}}" was created from {{value1}} and is unaffected. Orca could not also update your local {{value2}} branch because this clone only has recent history, so Git cannot confirm local {{value2}} is just behind. To fix this for every new workspace, run once:',
          { value0: worktreeName, value1: result.baseRef, value2: result.localBranch }
        )
      : translate(
          'auto.store.slices.worktrees.localBaseRefShallowHistory',
          'Your workspace was created from {{value0}} and is unaffected. Orca could not also update your local {{value1}} branch because this clone only has recent history, so Git cannot confirm local {{value1}} is just behind. To fix this for every new workspace, run once:',
          { value0: result.baseRef, value1: result.localBranch }
        )
    return (
      <>
        {explanation}{' '}
        <code className="rounded bg-accent px-1 py-px font-mono [overflow-wrap:anywhere]">
          {unshallowCommand(result)}
        </code>
      </>
    )
  }
  const detail = localBaseRefRefreshFailureDetail(result)
  return worktreeName
    ? translate(
        'auto.store.slices.worktrees.localBaseRefRefreshFailedDescriptionNamed',
        'Workspace "{{value0}}" was created from {{value1}}, but Orca could not fast-forward local {{value2}}. {{value3}}',
        {
          value0: worktreeName,
          value1: result.baseRef,
          value2: result.localBranch,
          value3: detail
        }
      )
    : translate(
        'auto.store.slices.worktrees.903b51c2ed',
        'Workspace created from {{value0}}, but Orca could not fast-forward local {{value1}}. {{value2}}',
        { value0: result.baseRef, value1: result.localBranch, value2: detail }
      )
}

function stopRefreshingLocalBaseRef(
  id: string,
  localBranch: string,
  updateSettings: AppState['updateSettings']
): void {
  void Promise.resolve(updateSettings({ refreshLocalBaseRefOnWorktreeCreate: false }))
    .then(() => {
      toast.dismiss(id)
      toast.success(
        translate(
          'auto.store.slices.worktrees.localBaseRefRefreshTurnedOff',
          'Orca will no longer update local {{value0}}',
          { value0: localBranch }
        ),
        {
          description: translate(
            'auto.store.slices.worktrees.localBaseRefRefreshTurnedOffDescription',
            'Turn it back on in Settings › {{value0}}.',
            { value0: getKeepLocalMainUpToDateTitle() }
          )
        }
      )
    })
    .catch(() => {
      toast.error(
        translate(
          'auto.store.slices.worktrees.localBaseRefRefreshTurnOffFailed',
          'Could not turn off {{value0}}',
          { value0: getKeepLocalMainUpToDateTitle() }
        )
      )
    })
}

export function showLocalBaseRefRefreshToast(
  result: LocalBaseRefRefreshResult | undefined,
  createdWorktree: Pick<Worktree, 'id' | 'repoId' | 'displayName' | 'branch' | 'path'> | undefined,
  updateSettings: AppState['updateSettings']
): void {
  if (!result || result.status === 'updated') {
    return
  }

  const worktreeName = createdWorktree ? resolveWorktreeDisplayName(createdWorktree).trim() : ''
  // Why: one id per repo and branch because creates toward one target share a run, so its result is one fact, not one per create.
  const id = `local-base-ref-refresh-failed:${createdWorktree?.repoId ?? 'unknown'}:${result.localBranch}`

  // Why a custom body: sonner's native action slot pinches beside a multi-line description.
  // Infinity so create-time failures aren't buried; the opt-out lives here since the setting is opt-in.
  toast.warning(refreshFailureTitle(result, worktreeName), {
    id,
    description: (
      <div className="flex w-full flex-col gap-3">
        <p className="text-sm leading-5 text-popover-foreground/80">
          {refreshFailureDescription(result, worktreeName)}
        </p>
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            onClick={() => stopRefreshingLocalBaseRef(id, result.localBranch, updateSettings)}
          >
            {translate(
              'auto.store.slices.worktrees.localBaseRefRefreshTurnOff',
              'Stop updating local {{value0}}',
              { value0: result.localBranch }
            )}
          </Button>
        </div>
      </div>
    ),
    duration: Infinity,
    dismissible: true
  })
}
