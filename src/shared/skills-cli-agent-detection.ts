import { detectCommandsInInstallDirs } from './local-agent-install-dir-detection'
import { toSkillsCliAgentKeys } from './skills-cli-agent-keys'
import {
  getTuiAgentDetectionProbeCommands,
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  resolveDetectedTuiAgentIds
} from './tui-agent-detection-commands'

/** Agents Orca can see on this host, as `skills --agent` keys; empty when it sees none. */
export function detectSkillsCliAgentKeys(): string[] {
  const runtime = process.platform
  const probes = getTuiAgentDetectionProbeCommands(KNOWN_TUI_AGENT_DETECTION_COMMANDS, runtime)
  const detected = resolveDetectedTuiAgentIds(
    KNOWN_TUI_AGENT_DETECTION_COMMANDS,
    detectCommandsInInstallDirs(probes),
    runtime
  )
  return detected.length === 0 ? [] : toSkillsCliAgentKeys(detected)
}
