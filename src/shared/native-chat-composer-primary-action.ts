// The composer's one button: Send, or Stop while the agent works. Desktop and phone share it.

export function nativeChatComposerStops(input: {
  isWorking: boolean
  /** No Enter key sends here (the phone), so content to send keeps Send while the agent works. */
  sendsWhileWorking?: boolean
  /** Text or an attachment is ready to send. */
  hasContent?: boolean
}): boolean {
  return input.isWorking && !(input.sendsWhileWorking === true && input.hasContent === true)
}
