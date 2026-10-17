import { z } from 'zod'

/** Longest data URL one icon may reply with. */
export const MAX_REPO_ICON_DATA_URL_BYTES = 16 * 1024
export const MAX_REPO_ICON_IDS_PER_READ = 16
/** A full reply fits by construction: every id answers with at most one capped icon. */
export const MAX_REPO_ICON_READ_REPLY_BYTES =
  MAX_REPO_ICON_DATA_URL_BYTES * MAX_REPO_ICON_IDS_PER_READ

export const RepoIconDataUrlsParams = z.object({
  ids: z.array(z.string().min(1).max(64)).max(MAX_REPO_ICON_IDS_PER_READ)
})

/**
 * One entry per requested id, in request order. `dataUrl` is null when the host has no image for
 * the id or could not make one within the caps; the client then draws its own fallback.
 */
export type RepoIconDataUrlsReply = {
  icons: { id: string; dataUrl: string | null }[]
}
