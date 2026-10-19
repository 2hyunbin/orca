import {
  getGitRemoteProviderIdentity,
  getProjectIdForProviderIdentity
} from './project-host-setup-projection'
import type { ProjectProviderIdentity } from './project-types'
import type { Repo } from './repo-types'

function describeIdentity(identity: ProjectProviderIdentity): string {
  return `${identity.host ? `${identity.host}/` : ''}${identity.owner}/${identity.repo}`
}

/**
 * Linking stamps the project's identity as the folder's `upstream`, which is only sound when the
 * folder's own remote cannot place it (no remote, a non-GitHub remote). A folder whose remote names
 * another GitHub repository would be silently relabelled into the wrong project (#30663).
 */
export function assertImportedFolderRemoteMatchesProject(
  repo: Pick<Repo, 'gitRemoteIdentity'>,
  projectIdentity: ProjectProviderIdentity
): void {
  const folderIdentity = getGitRemoteProviderIdentity(repo)
  if (
    !folderIdentity ||
    getProjectIdForProviderIdentity(folderIdentity) ===
      getProjectIdForProviderIdentity(projectIdentity)
  ) {
    return
  }
  const remoteName = repo.gitRemoteIdentity?.remoteName ?? 'origin'
  throw new Error(
    `Imported folder does not match the selected project: its Git remote "${remoteName}" points at ${describeIdentity(folderIdentity)}, not ${describeIdentity(projectIdentity)}. Choose the project that matches this folder, or, if the folder is a fork, add the project's repository as its "upstream" remote.`
  )
}
