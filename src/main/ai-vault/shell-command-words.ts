// Reads a command line as a shell would, only as far as the resume guard needs: into commands,
// each a list of words with their quotes removed.

// A word joins quoted runs and other text (`--session="a b"` is one word). Outside quotes, `&&`,
// `||`, `;`, `|`, `&` and a line break end a command even when glued to a word; `>&`, `<&` and
// `&>` are redirections inside one.
const SHELL_TOKEN =
  /(?:"[^"\\]*(?:\\.[^"\\]*)*"|'[^']*'|[<>]&|&>|[^\s&|;])+|&&|\|\||[&|;]|\r\n|\r|\n/g
const QUOTED_RUN = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'/g
const LINE_BREAKS = new Set(['\r\n', '\r', '\n'])
const SEPARATORS = new Set(['&&', '||', ';', '|', '&', ...LINE_BREAKS])
// POSIX `\`, PowerShell `` ` `` and cmd `^` before a line break continue the command.
const CONTINUATION_MARK = /[\\`^]$/

/** Each command of `text`, as its words. */
export function* shellCommands(text: string): Generator<string[]> {
  let words: string[] = []
  let previous = ''
  for (const [token] of text.matchAll(SHELL_TOKEN)) {
    if (!SEPARATORS.has(token)) {
      words.push(
        token.replace(
          QUOTED_RUN,
          (_run, double?: string, single?: string) => double ?? single ?? ''
        )
      )
    } else if (LINE_BREAKS.has(token) && CONTINUATION_MARK.test(previous)) {
      const continued = words.pop()!.slice(0, -1)
      if (continued) {
        words.push(continued)
      }
    } else if (words.length > 0) {
      yield words
      words = []
    }
    previous = token
  }
  if (words.length > 0) {
    yield words
  }
}

/** The name a word runs as: its path's last name, lower-case. */
export function commandName(word: string): string {
  return word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1).toLowerCase()
}
