// Installs main's model check on every layout records frame for one test's life.

import { layoutFrameModelErrors } from './workspace-layout-frame-model-check'
import { observeWorkspaceLayoutFrames } from './workspace-layout-frame-observer'

export function installLayoutFrameModelCheck(): {
  /** Every mismatch found, frame by frame. */
  failures: string[]
  /** How many frames were checked. */
  checked: () => number
  uninstall: () => void
} {
  const failures: string[] = []
  let checked = 0
  observeWorkspaceLayoutFrames((observation) => {
    checked += 1
    failures.push(...layoutFrameModelErrors(observation))
  })
  return { failures, checked: () => checked, uninstall: () => observeWorkspaceLayoutFrames(null) }
}
