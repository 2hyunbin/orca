/** Writes a move's record through every phase up to its own, as the journal requires. */
import {
  WSL_MOVE_CUTOVER_PHASES,
  type WslMoveCutover
} from '../../../../shared/wsl-move/wsl-move-cutover'
import { writeWslMoveCutover } from '../../moving-wsl-projects/wsl-move-cutover-journal'

export function seedWslMoveCutover(userDataPath: string, cutover: WslMoveCutover): void {
  for (const phase of WSL_MOVE_CUTOVER_PHASES) {
    writeWslMoveCutover(userDataPath, { ...cutover, phase })
    if (phase === cutover.phase) {
      return
    }
  }
}
