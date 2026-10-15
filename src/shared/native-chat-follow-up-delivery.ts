/** How a message sent while the agent works is delivered; one vocabulary for desktop and phone. */
export type NativeChatFollowUpDelivery = 'queue' | 'steer'

/** The follow-up setting (absent means queue); the alternate does the opposite for one message. */
export function resolveNativeChatFollowUpDelivery(input: {
  alternate: boolean
  queueFollowUps?: boolean
}): NativeChatFollowUpDelivery {
  return (input.queueFollowUps !== false) !== input.alternate ? 'queue' : 'steer'
}
