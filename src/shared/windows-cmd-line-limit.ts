/** cmd.exe's own documented ceiling; callers that go through sshd budget below it. */
export const CMD_EXE_COMMAND_LINE_MAX_CHARS = 8191
/** What a cmd.exe pane runs ahead of its startup line (`/K <this> & <line>`). */
export const CMD_UTF8_SETUP_COMMAND = 'chcp 65001 > nul'

/**
 * Whether cmd.exe reads `line` as one line: measured after it expands each `%NAME%` from `env`
 * once, the way cmd does, with `reserve` chars kept free; a line break ends the line early.
 */
export function fitsCmdLine(line: string, env: Record<string, string> = {}, reserve = 0): boolean {
  const expanded = line.replace(/%([^%\r\n]+)%/g, (ref, name: string) => env[name] ?? ref)
  return !/[\r\n]/.test(expanded) && expanded.length + reserve <= CMD_EXE_COMMAND_LINE_MAX_CHARS
}
