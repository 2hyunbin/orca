import type { Repo } from '../../../../shared/repo-types'
import type { RepoUpdate } from './repo-state'

/** Whether main's row carries every field the update set, as the host answered it. */
export function repoShowsUpdate(row: Repo, expected: Repo, updates: RepoUpdate): boolean {
  return Object.keys(updates).every((key) => {
    const shown = Reflect.get(row, key)
    // Main withholds an uploaded icon's data URL (repoIcon null); its id arrives separately.
    if (key === 'repoIcon' && shown === null) {
      return true
    }
    return JSON.stringify(shown) === JSON.stringify(Reflect.get(expected, key))
  })
}
