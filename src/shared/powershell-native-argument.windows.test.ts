import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import {
  getPowerShellEscapeNativeArgsFunction,
  quotePowerShellLiteral
} from './powershell-native-argument'

/** Runs `build(native)` in `powershell`, where `native` invokes a program that records its argv. */
async function captureNativeArgv(
  root: string,
  powershell: string,
  build: (native: string) => string
): Promise<string[]> {
  const capturePath = join(root, 'argv.json')
  const scriptPath = join(root, 'capture.js')
  await writeFile(
    scriptPath,
    `require('node:fs').writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.argv.slice(2)))`
  )
  const native = `& ${quotePowerShellLiteral(process.execPath)} ${quotePowerShellLiteral(scriptPath)}`
  const result = await runProcess({
    program: powershell,
    args: ['-NoProfile', '-NonInteractive', '-Command', build(native)],
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
    const capture = (quoted: string): Promise<string[]> =>
      captureNativeArgv(root, 'powershell.exe', (native) => `${native} ${quoted}`)
    try {
      const plain = 'line one\r\nline two $HOME `tick\nO\u2019Brien \u201Cdouble\u201D end'
      expect(await capture(quotePowerShellLiteral(plain))).toEqual([plain])

      // Why compare with the old raw single-quoted form: 5.1 drops embedded `"` from native argv
      // either way, and the one-line form must not change what reaches the program.
      const withQuotes = 'say "hi"\nbye'
      const legacy = `'${withQuotes.replace(/'/g, "''")}'`
      expect(await capture(quotePowerShellLiteral(withQuotes))).toEqual(await capture(legacy))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

const isWindows = process.platform === 'win32'
const pwshAvailable =
  isWindows &&
  spawnSync('pwsh.exe', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status === 0

// Text Windows PowerShell passes without its own quotes, which no escaping survives.
const UNQUOTED = ['"fix the login bug"', 'a"b c"d']

describe.each([
  {
    name: 'Windows PowerShell',
    powershell: 'powershell.exe',
    prelude: '',
    available: isWindows,
    unquoted: ['fix the login bug', 'ab cd']
  },
  {
    name: 'pwsh',
    powershell: 'pwsh.exe',
    prelude: '',
    available: pwshAvailable,
    unquoted: UNQUOTED
  },
  {
    name: 'pwsh with Legacy passing',
    powershell: 'pwsh.exe',
    prelude: "$PSNativeCommandArgumentPassing = 'Legacy'",
    available: pwshAvailable,
    unquoted: UNQUOTED
  }
])('__OrcaEscapeNativeArgs under $name', ({ powershell, prelude, available, unquoted }) => {
  // Why a function: the agent wrappers hand their own $args to the native command the same way.
  const capture = (root: string, value: string): Promise<string[]> =>
    captureNativeArgv(
      root,
      powershell,
      (native) =>
        `${prelude}\n${getPowerShellEscapeNativeArgsFunction()}\n` +
        `function agent { ${native} @(__OrcaEscapeNativeArgs 'node.exe' $args) }\n` +
        `agent ${quotePowerShellLiteral(value)}`
    )

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
        'look in C:\\dir\\\n',
        'C:\\no-space\\',
        'C:\\no-space\\\n',
        'Fix " --dangerously-bypass-approvals-and-sandbox " thanks'
      ]) {
        expect(await capture(root, value)).toEqual([value])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(!available)(
    'keeps text Windows PowerShell will not quote as one argument',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-ps-native-args-'))
      try {
        for (const [index, value] of UNQUOTED.entries()) {
          expect(await capture(root, value)).toEqual([unquoted[index]])
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
