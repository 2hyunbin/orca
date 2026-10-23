import { collapsedWhitespacePrefix } from './collapsed-whitespace-prefix'

export const MAX_TOOL_PREVIEW_LENGTH = 80

export function collapsedToolInputPrefix(input: string): string {
  return collapsedWhitespacePrefix(input, MAX_TOOL_PREVIEW_LENGTH)
}

/** `/bin/zsh -lc "git status"` is how the agent reaches a shell, not what it
 *  ran. Every such row opens with the same fourteen characters, which is the
 *  width the command itself needed. Strip the wrapper when the whole remainder
 *  is one quoted string; anything else (a pipeline into the wrapper, an unpaired
 *  quote) is left exactly as the agent wrote it.
 *
 *  Must run BEFORE any truncation: the closing quote is what proves the match,
 *  and an 80-character prefix has already dropped it. */
const LOGIN_SHELL_COMMAND =
  /^\s*(?:.*[\\/])?(?:ba|z|k|da|fi)?sh(?:\.exe)?\s+-[a-zA-Z]*c\s+(['"])([\s\S]*)\1\s*$/

export function unwrapLoginShellCommand(command: string): string {
  return LOGIN_SHELL_COMMAND.exec(command)?.[2] ?? command
}
