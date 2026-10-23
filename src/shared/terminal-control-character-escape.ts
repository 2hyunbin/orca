/* oxlint-disable no-control-regex -- Terminal control bytes must be escaped. */
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/g
const CONTROL_CHARACTERS_EXCEPT_NEWLINE = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g

export function escapeTerminalControlCharacters(value: string, escapeLineBreaks = false): string {
  return value.replace(
    escapeLineBreaks ? CONTROL_CHARACTERS : CONTROL_CHARACTERS_EXCEPT_NEWLINE,
    (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`
  )
}
