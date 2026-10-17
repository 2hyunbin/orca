// Why a re-export: the keys moved to shared for the sidebar row builder; renderer callers keep this path.
export {
  getGitHubPRCacheKey,
  getGitHubRepoCacheKey,
  getLegacyGitHubPRCacheKey,
  getLegacyGitHubRepoCacheKey
} from '../../../../shared/github/github-cache-key'
