import { COMMAND_TOKEN_SCAN_MAX_CHARS } from './command-token-scanner'

const SLEEP_PREFIX =
  /^[ \t]*(?:sleep|\/bin\/sleep|\/usr\/bin\/sleep)[ \t]+(?:\d+(?:\.\d+)?|\.\d+)[smhd]?[ \t]*&&[ \t]*/

/** Launch preparation hint only; the shell still receives the complete command. */
export function getLaunchCommandAfterDelay(command: string): string {
  const prefix = command.slice(0, COMMAND_TOKEN_SCAN_MAX_CHARS)
  let offset = 0
  while (offset < prefix.length) {
    const match = SLEEP_PREFIX.exec(prefix.slice(offset))
    if (!match) {
      break
    }
    offset += match[0].length
  }
  return command.slice(offset)
}
