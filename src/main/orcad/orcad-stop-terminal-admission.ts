/**
 * The running server's terminal admission, held closed from the moment it begins to stop until it
 * exits: a terminal admitted then would die with it, uncounted, whatever a census asked.
 */
let runningTerminalAdmission: { holdUntilExit(): void } | null = null

export function bindOrcadStopTerminalAdmission(admission: { holdUntilExit(): void }): void {
  runningTerminalAdmission = admission
}

export function holdOrcadTerminalAdmissionUntilExit(): void {
  runningTerminalAdmission?.holdUntilExit()
}
