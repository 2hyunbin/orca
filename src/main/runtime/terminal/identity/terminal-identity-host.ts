import type { RuntimeGraphStatus } from '../../../../shared/runtime-types'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'

export type TerminalIdentityHost = {
  runtimeId(): string
  rendererGraphEpoch(): number
  graphSequence(): number
  graphStatus(): RuntimeGraphStatus
  leaves(): Map<string, RuntimeLeafRecord>
  leavesByPtyId(): Map<string, RuntimeLeafRecord[]>
  ptysById(): Map<string, RuntimePtyWorktreeRecord>
  wslDistroByPtyId(): Map<string, string>
  titleObservationSequence(): number
  setTitleObservationSequence(sequence: number): void
  assertGraphReady(): void
  rejectWaitersForHandle(handle: string, code: string): void
  structuredTerminalRefusal(handle: string): Error
  isLiveStructuredWorker(handle: string): boolean
}
