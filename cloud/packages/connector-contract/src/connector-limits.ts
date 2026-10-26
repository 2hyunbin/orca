/** Bumped only for a breaking change; within a version, fields and capabilities are only added. */
export const CONNECTOR_CONTRACT_VERSION = 1

export const CONNECTOR_LIMITS = {
  signInTtlMs: 10 * 60 * 1000,
  signInPollIntervalSeconds: 5,
  // Added to the interval on every early poll (slow_down).
  signInSlowDownStepSeconds: 5,
  signInPendingPerIp: 5,
  signInPendingTotal: 1_000,
  sessionTtlMs: 60 * 60 * 1000,
  initialPollHoldMs: 50_000,
  // The machine abandons a held poll after this; the cloud's holdMs stays below it.
  pollTimeoutMs: 70_000,
  maxDeliveriesPerPoll: 20,
  deliveryTtlMs: 5 * 60 * 1000,
  // A handed-out delivery not yet received goes out again, same id, after this.
  leaseMs: 30_000,
  // A leased delivery that was never received expires this long after expiresAt.
  leasedExpiryGraceMs: 30_000,
  // The machine refuses a delivery with less than this left before its deadline.
  minDeadlineLeftMs: 10_000,
  maxLastAssistantMessageBytes: 8 * 1024
} as const
