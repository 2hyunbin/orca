import { useAppStore } from '../../store'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '../../store/workspace-record-selectors'
import { takeEchoesNoLongerFenced } from './mirrored-snapshot-host-fence'

/** Replays a server's frame the echo fence held back once that server's own copy of the workspace lists. */
export function installFencedEchoReplay(): () => void {
  return useAppStore.subscribe((state, previous) => {
    if (
      selectWorktreesByRepo(state) === selectWorktreesByRepo(previous) &&
      selectDetectedWorktreesByRepo(state) === selectDetectedWorktreesByRepo(previous) &&
      selectFolderWorkspaces(state) === selectFolderWorkspaces(previous)
    ) {
      return
    }
    const released = takeEchoesNoLongerFenced(state)
    if (released.length === 0) {
      return
    }
    void import('../web-runtime-session-snapshot').then(
      ({ refreshWebRuntimeSessionTabsSnapshot }) => {
        for (const { environmentId, workspaceId } of released) {
          void refreshWebRuntimeSessionTabsSnapshot(environmentId, workspaceId, {
            acceptCurrentSnapshot: true
          })
        }
      }
    )
  })
}
