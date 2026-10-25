export type SubmissionSource = {
  ordinal: number
  address: string
  fingerprint: string
  rank: number
  time: number
  queued?: string
  sequence: number
  inDoubt: boolean
  eligible: boolean
  signature: string
  rawSignature: string
  attemptSignature: string
}
