import { defineFixture } from '../../component-fixtures/component-fixture'
import ImportedWorktreesVisibilityLine from './ImportedWorktreesVisibilityLine'

const hiddenWorktrees = [
  { displayName: 'feature-one', path: '/projects/orca-feature-one' },
  { displayName: 'feature-two', path: '/projects/orca-feature-two' }
]

export const hint = defineFixture({
  width: 320,
  render: () => (
    <div className="bg-worktree-sidebar py-2">
      <ImportedWorktreesVisibilityLine
        repoDisplayName="Orca"
        hiddenWorktrees={hiddenWorktrees}
        placement="repo-group"
        pending={false}
        error={null}
        onReview={() => undefined}
        onKeepHidden={async () => true}
      />
    </div>
  )
})

export const remoteHint = defineFixture({
  width: 320,
  render: () => (
    <div className="bg-worktree-sidebar py-2">
      <ImportedWorktreesVisibilityLine
        repoDisplayName="Orca"
        hostContextLabel="dev-server"
        hostContextHostId="ssh:dev-server"
        hiddenWorktrees={hiddenWorktrees}
        placement="pinned-fallback"
        pending={false}
        error={null}
        onReview={() => undefined}
        onKeepHidden={async () => true}
      />
    </div>
  )
})
