import React, { useId } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { translate } from '@/i18n/i18n'
import type { ImportedWorktreeVisibilityPreview } from './ImportedWorktreesVisibilityLine'

export default function WorkspaceDiscoveryWorktreeList({
  worktrees,
  selected,
  query,
  pending,
  onChange
}: {
  worktrees: readonly ImportedWorktreeVisibilityPreview[]
  selected: ReadonlySet<string>
  query: string
  pending: boolean
  onChange: (selected: ReadonlySet<string>) => void
}): React.JSX.Element {
  const prefix = useId()
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = worktrees.filter((worktree) =>
    [worktree.displayName, worktree.path, worktree.branch ?? ''].some((value) =>
      value.toLocaleLowerCase().includes(normalizedQuery)
    )
  )
  return (
    <div
      role="group"
      aria-label={translate('workspaceDiscovery.available', 'Workspaces available to add')}
      className="grid min-w-0 gap-1 py-1"
    >
      {filtered.map((worktree, index) => {
        const id = `${prefix}-${index}`
        const branch = worktree.branch?.replace(/^refs\/heads\//, '')
        return (
          <label
            key={worktree.path}
            htmlFor={id}
            title={worktree.path}
            className="flex min-w-0 cursor-pointer items-start gap-2 rounded-md px-1.5 py-2 hover:bg-worktree-sidebar-accent"
          >
            <Checkbox
              id={id}
              checked={selected.has(worktree.path)}
              disabled={pending}
              className="mt-0.5 scroll-mt-40"
              onCheckedChange={(checked) => {
                const next = new Set(selected)
                if (checked === true) {
                  next.add(worktree.path)
                } else {
                  next.delete(worktree.path)
                }
                onChange(next)
              }}
            />
            <span className="grid min-w-0 flex-1 gap-0.5 break-words text-xs">
              <span>{worktree.displayName}</span>
              {branch && branch !== worktree.displayName ? (
                <span className="text-2xs text-muted-foreground">{branch}</span>
              ) : null}
              <span className="break-all text-2xs text-muted-foreground">{worktree.path}</span>
            </span>
          </label>
        )
      })}
      {filtered.length === 0 ? (
        <p className="px-1.5 py-2 text-xs text-muted-foreground">
          {pending
            ? translate('workspaceDiscovery.checking', 'Checking workspaces…')
            : normalizedQuery
              ? translate('workspaceDiscovery.noMatches', 'No matching workspaces.')
              : translate('workspaceDiscovery.noneHidden', 'No hidden workspaces.')}
        </p>
      ) : null}
    </div>
  )
}
