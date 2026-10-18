import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import {
  getPowerShellNativeArgsFunction,
  quotePowerShellLiteral
} from './powershell-native-argument'

async function captureNativeArgv(
  root: string,
  quotedArg: string,
  powershell = 'powershell.exe',
  viaNativeArgs = false
): Promise<string[]> {
  const capturePath = join(root, 'argv.json')
  const scriptPath = join(root, 'capture.js')
  await writeFile(
    scriptPath,
    `require('node:fs').writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.argv.slice(2)))`
  )
  const native = `& ${quotePowerShellLiteral(process.execPath)} ${quotePowerShellLiteral(scriptPath)}`
  // Why a function: the agent wrappers hand their own $args to the native command the same way.
  const command = viaNativeArgs
    ? `${getPowerShellNativeArgsFunction()}\nfunction agent { ${native} @(__OrcaNativeArgs $args) }\nagent ${quotedArg}`
    : `${native} ${quotedArg}`
  const result = await runProcess({
    program: powershell,
    args: ['-NoProfile', '-NonInteractive', '-Command', command],
    cwd: root
  })
  expect(result.code, JSON.stringify(result)).toBe(0)
  const argv: string[] = JSON.parse(await readFile(capturePath, 'utf8'))
  return argv
}

// Why native: argv marshalling, not the generated text, is what a launched agent actually receives.
it.skipIf(process.platform !== 'win32')(
  'passes a multi-line value to a native program exactly as the single-quoted form did',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ps-multiline-'))
    try {
      const plain = 'line one\r\nline two $HOME `tick\nO\u2019Brien \u201Cdouble\u201D end'
      expect(await captureNativeArgv(root, quotePowerShellLiteral(plain))).toEqual([plain])

      // Why compare with the old raw single-quoted form: 5.1 drops embedded `"` from native argv
      // either way, and the one-line form must not change what reaches the program.
      const withQuotes = 'say "hi"\nbye'
      const legacy = `'${withQuotes.replace(/'/g, "''")}'`
      expect(await captureNativeArgv(root, quotePowerShellLiteral(withQuotes))).toEqual(
        await captureNativeArgv(root, legacy)
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

const pwshAvailable =
  process.platform === 'win32' &&
  spawnSync('pwsh.exe', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status === 0

describe.each([
  { powershell: 'powershell.exe', available: process.platform === 'win32' },
  { powershell: 'pwsh.exe', available: pwshAvailable }
])('__OrcaNativeArgs under $powershell', ({ powershell, available }) => {
  it.skipIf(!available)('delivers embedded quotes and backslashes exactly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ps-native-args-'))
    try {
      for (const value of [
        'say "hi" to "bob"',
        'line1 "a"\nline2 "b c"',
        'path C:\\dir\\" end "q"',
        'a "" b',
        'a"b',
        'look in C:\\dir\\',
        'C:\\no-space\\',
        'Fix " --dangerously-bypass-approvals-and-sandbox " thanks'
      ]) {
        expect(
          await captureNativeArgv(root, quotePowerShellLiteral(value), powershell, true)
        ).toEqual([value])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(!available)('never splits a fully quoted value into several arguments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ps-native-args-'))
    try {
      const value = '"fix the login bug"'
      const argv = await captureNativeArgv(root, quotePowerShellLiteral(value), powershell, true)
      // Windows PowerShell passes such text unquoted, which no escaping survives; it stays one argument.
      expect(argv).toEqual([powershell === 'pwsh.exe' ? value : 'fix the login bug'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
