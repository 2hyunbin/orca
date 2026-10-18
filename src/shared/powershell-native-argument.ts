export function quotePowerShellLiteral(value: string): string {
  if (/[\r\n]/.test(value)) {
    return quotePowerShellMultilineLiteral(value)
  }
  // Why: PowerShell also ends single-quoted strings at typographic single quotes.
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`
}

/**
 * Why one physical line: a raw line break typed into PowerShell submits the line, and Windows
 * PowerShell 5.1 without PSReadLine then waits at `>>` for an empty line that never comes.
 * Backtick escapes keep every byte, so `\r\n` stays `\r\n` exactly as the single-quoted form
 * delivered it.
 */
function quotePowerShellMultilineLiteral(value: string): string {
  const escaped = value.replace(/[`$"\u201C\u201D\u201E\r\n]/g, (char) =>
    char === '\r' ? '`r' : char === '\n' ? '`n' : `\`${char}`
  )
  return `"${escaped}"`
}

/**
 * PowerShell function that escapes arguments for `$Program`, for Orca's agent wrappers to splat.
 *
 * Why at runtime: the escaping depends on the PowerShell reading the line. Legacy argv passing
 * (Windows PowerShell 5.1, pwsh before 7.3, and 7.3's `Windows` mode for `.cmd`/`.bat`) leaves
 * embedded `"` unescaped, so the program drops them; otherwise PowerShell escapes them itself and
 * must get the text untouched. Windows PowerShell also quotes only when whitespace sits outside
 * quotes it counts naively, and never doubles a trailing backslash; when it won't quote, no escaping
 * survives, so that text is left as before.
 */
export function getPowerShellEscapeNativeArgsFunction(): string {
  return `function Global:__OrcaEscapeNativeArgs([string]$Program, [object[]]$Arguments) {
    Set-StrictMode -Off
    $mode = $PSNativeCommandArgumentPassing
    if ($mode -eq 'Standard' -or ($mode -eq 'Windows' -and $Program -notmatch '\\.(bat|cmd)$')) { return $Arguments }
    $desktop = $PSVersionTable.PSVersion.Major -lt 6
    foreach ($arg in $Arguments) {
        if ($arg -isnot [string] -or $arg -notmatch '["\\\\]') { $arg; continue }
        $willQuote = $arg -match '^(?:[^"]*"[^"]*")*[^"]*\\s'
        if ($desktop -and -not $willQuote -and $arg -match '\\s') { $arg; continue }
        $escaped = $arg -replace '(\\\\*)"', '$1$1\\"'
        if ($desktop -and $willQuote) { $escaped -replace '(\\\\+)\\z', '$1$1' } else { $escaped }
    }
}`
}

export function quotePowerShellNativeArgument(value: string): string {
  // Why: Windows PowerShell 5.1 drops unescaped embedded quotes when it
  // constructs argv for native executables such as wsl.exe.
  return quotePowerShellLiteral(value.replace(/(\\*)"/g, '$1$1\\"'))
}
