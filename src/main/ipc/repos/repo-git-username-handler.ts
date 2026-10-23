import { ipcMain } from 'electron'
import type { Store } from '../../persistence'
import { isFolderRepo } from '../../../shared/repo-kind'
import { resolveLocalGitUsername } from '../../git/git-username'

export function registerRepoGitUsernameHandler(store: Store): void {
  ipcMain.handle('repos:getGitUsername', async (_event, args: { repoId: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo || isFolderRepo(repo)) {
      return ''
    }
    // SSH Git config is unavailable to this local handler.
    if (repo.connectionId) {
      return ''
    }
    return resolveLocalGitUsername(repo.path)
  })
}
