// Strict Send params and result arms make the queue opt-in on paired clients. The host can still
// publish cards kept across restart or close without this gate. Mid-turn queueing stays dark until
// its steer rules ship; cards expose their draft-to-submission link and pause in the publication.
export const AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY =
  'agent-session.queued-messages.v1' as const

/** Strict Send params require a capability before clients include message choices. */
export const AGENT_SESSION_MESSAGE_CHOICES_RUNTIME_CAPABILITY =
  'agent-session.message-choices.v1' as const

// Kept cards may be edited without mid-turn queueing, so editing has its own gate.
export const AGENT_SESSION_QUEUED_MESSAGE_EDIT_RUNTIME_CAPABILITY =
  'agent-session.queued-message-edit.v1' as const

// A waiting command needs the queue's card surface to show where it went.
export const AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY =
  'agent-session.queued-commands.v1' as const
