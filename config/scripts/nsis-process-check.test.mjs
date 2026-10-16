import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const hooks = readFileSync(new URL('../nsis/orca-installer-hooks.nsh', import.meta.url), 'utf8')
const processCheck = readFileSync(
  new URL('../nsis/orca-process-check.nsh', import.meta.url),
  'utf8'
)
const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder/package.json'))
const upstreamChecks = readFileSync(
  join(
    dirname(builderRequire.resolve('app-builder-lib/package.json')),
    'templates/nsis/include/allowOnlyOneInstallerInstance.nsh'
  ),
  'utf8'
)

function readPowerShellProbe(source = processCheck) {
  const match = source.match(/nsExec::Exec `"\$PowerShellPath"(.*?) -(?:C|Command) "([^"\n]+)"`/)
  if (!match) {
    throw new Error('The NSIS PowerShell invocation was not found')
  }
  return { args: match[1].trim().split(/\s+/).filter(Boolean), command: match[2] }
}

describe('NSIS process-check integration', () => {
  it('loads the capability hook through the installer and uninstaller include', () => {
    expect(hooks).toContain('!include "${__FILEDIR__}\\orca-process-check.nsh"')
    expect(processCheck).toMatch(/!macro customCheckAppRunning\b/)
    expect(processCheck).toContain('!include "getProcessInfo.nsh"')
    expect(processCheck).toMatch(/^Var pid$/m)
    expect(processCheck).toMatch(/^Var \/GLOBAL IsPowerShellAvailable$/m)
  })

  it('keeps upstream process selection, retries, and installation-mode handling', () => {
    expect(processCheck).toContain('!insertmacro _CHECK_APP_RUNNING')
    expect(processCheck).not.toMatch(/!macro (?:FIND_PROCESS|KILL_PROCESS|_CHECK_APP_RUNNING)\b/)
    expect(processCheck).not.toMatch(/\b(?:Stop-Process|taskkill|Set-ExecutionPolicy)\b/)
    const findProcess = upstreamChecks.match(/!macro FIND_PROCESS\b[\s\S]*?!macroend/)?.[0]
    if (!findProcess) {
      throw new Error('The upstream process finder was not found')
    }
    expect(readPowerShellProbe().args).toEqual(readPowerShellProbe(findProcess).args)
  })

  // Why static: Restricted policy permits inline -Command, so only this shape needs pinning.
  it('runs an inline query that exits nonzero when the process table cannot be read', () => {
    expect(readPowerShellProbe().command).toBe(
      'try { Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Out-Null; exit 0 } catch { exit 1 }'
    )
    expect(processCheck).not.toMatch(/-(?:File|EncodedCommand|ExecutionPolicy)\b/)
  })

  it('uses PowerShell only after a successful probe and otherwise keeps the image-name fallback', () => {
    const decision = processCheck.match(/Pop \$0[\s\S]*?!insertmacro _CHECK_APP_RUNNING/)?.[0]
    expect(decision?.replace(/^\s*;.*$/gm, '').replace(/\s+/g, ' ')).toBe(
      'Pop $0 StrCpy $IsPowerShellAvailable 1 ${if} $0 == 0 StrCpy $IsPowerShellAvailable 0 ${endIf} !insertmacro _CHECK_APP_RUNNING'
    )
  })
})
