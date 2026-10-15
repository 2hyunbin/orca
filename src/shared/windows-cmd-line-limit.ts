/** cmd.exe's own documented ceiling; callers that go through sshd budget below it. */
export const CMD_EXE_COMMAND_LINE_MAX_CHARS = 8191
/** What a cmd.exe pane runs ahead of its startup line (`/K <this> & <line>`). */
export const CMD_UTF8_SETUP_COMMAND = 'chcp 65001 > nul'

/** Whether `line` fits one cmd.exe line after each exact `%NAME%` is replaced once from `env` (no
 *  case-folding or substring syntax), with `reserve` chars kept free; a line break never fits. */
export function fitsCmdLine(line: string, env: Record<string, string> = {}, reserve = 0): boolean {
  const expanded = line.replace(/%([^%\r\n]+)%/g, (ref, name: string) => env[name] ?? ref)
  return !/[\r\n]/.test(expanded) && expanded.length + reserve <= CMD_EXE_COMMAND_LINE_MAX_CHARS
}
