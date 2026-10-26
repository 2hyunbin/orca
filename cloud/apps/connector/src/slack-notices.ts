import type { Notice, NoticeTarget } from './connector-adapter.js'
import type { PostBody } from './connector-posts.js'
import { slackText } from './slack-text.js'

function noticeText(notice: Notice): string {
  switch (notice.kind) {
    case 'paused':
      return slackText.paused
    case 'unlinked':
      return slackText.unlinked
    case 'update':
      return slackText.updateOrca
    case 'ask':
      return slackText.askPlace(notice.options)
    case 'only_owner':
      return slackText.onlyOwner(notice.ownerUserId)
    case 'already_answered':
      return slackText.alreadyAnswered
  }
}

// Meant only for the person who wrote: ephemeral in a channel; in a DM it is theirs anyway. Slack
// shows a threaded ephemeral only in a thread that already exists, so a top-level mention's goes to
// the channel.
export function slackNotice(
  target: NoticeTarget,
  notice: Notice
): { kind: 'message' | 'ephemeral'; body: PostBody } {
  const text = noticeText(notice)
  return target.direct
    ? { kind: 'message', body: { text } }
    : {
        kind: 'ephemeral',
        body: {
          text,
          user: target.userId,
          ...(target.inThread ? { threadTs: target.place.threadId } : {})
        }
      }
}
