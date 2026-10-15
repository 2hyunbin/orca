import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { buildWslLoginShellCommand } from '../../../../shared/wsl-login-shell-command'
import { useAppStore } from '@/store'
import { buildAgentFeatureSkillInstallCommand } from '@/lib/agent-feature-install-commands'
import {
  buildSkillCommandForRuntime,
  buildSkillInstallCommandForRuntime,
  buildSkillSetupTerminalCommand,
  getAgentSkillTerminalShellOverride,
  getSelectedAgentRuntime,
  getSkillDiscoveryTargetForRuntime
} from './CliSkillRuntimeSetup'

function decodeWslLoginShellScript(command: string): string {
  const encoded =
    /(?:--|--exec) sh -c '(?:eval \\"`|sh -c \\"\$\()?printf %s ([A-Za-z0-9+/=]+) \| base64 -d/.exec(
      command
    )?.[1]
  expect(encoded).toBeDefined()
  return Buffer.from(encoded!, 'base64').toString('utf8')
}

function getWslOuterShellScript(command: string): string {
  const script = /(?:--|--exec) sh -c '([^']+)' \} # Runs:/.exec(command)?.[1]
  expect(script).toBeDefined()
  // Simulate PowerShell 5.1's native argv boundary consuming quote escapes.
  return script!.replaceAll('\\"', '"')
}

describe('CliSkillRuntimeSetup runtime helpers', () => {
  it('keeps copied WSL skill installs valid for the target POSIX shell', () => {
    const skillCommand = 'npx skills add orchestration --global'
    const runtime = {
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      label: 'WSL Ubuntu'
    } as const
    const command = buildSkillInstallCommandForRuntime(skillCommand, runtime)
    const setupCommand = buildSkillSetupTerminalCommand(command, 'powershell.exe', runtime, 'win32')
    const encoded = Buffer.from(buildWslLoginShellCommand(skillCommand), 'utf8').toString('base64')

    expect(command).toBe(skillCommand)
    expect(setupCommand).toBe(
      `& { $PSNativeCommandArgumentPassing = 'Legacy'; wsl.exe -d 'Ubuntu' --exec sh -c 'sh -c \\"$(printf %s ${encoded} | base64 -d)\\"' } # Runs: ${skillCommand}`
    )
    expect(decodeWslLoginShellScript(setupCommand)).toContain(
      'exec "$_orca_wsl_shell" -ilc \'npx skills add orchestration --global\''
    )
  })

  it('keeps a Windows-selected WSL install inside WSL without the host preflight', () => {
    const skillCommand = 'npx skills add orchestration --global'
    const runtime = {
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      label: 'WSL Ubuntu'
    } as const
    const command = buildSkillCommandForRuntime(skillCommand, runtime, 'win32')
    const setupCommand = buildSkillSetupTerminalCommand(command, 'powershell.exe', runtime, 'win32')

    expect(command).toBe(skillCommand)
    expect(setupCommand).toContain("wsl.exe -d 'Ubuntu'")
    expect(setupCommand).not.toContain('where.exe npx')
    expect(decodeWslLoginShellScript(setupCommand)).toContain(
      'exec "$_orca_wsl_shell" -ilc \'npx skills add orchestration --global\''
    )
  })

  it('wraps WSL skill updates for the selected distro setup terminal', () => {
    const runtime = {
      runtime: 'wsl',
      wslDistro: 'Fedora Remix',
      label: 'WSL Fedora Remix'
    } as const
    const command = buildSkillCommandForRuntime('npx skills update orchestration --global', runtime)
    const setupCommand = buildSkillSetupTerminalCommand(command, 'powershell.exe', runtime, 'win32')

    expect(decodeWslLoginShellScript(setupCommand)).toContain(
      'exec "$_orca_wsl_shell" -ilc \'npx skills update orchestration --global\''
    )
  })

  it('scopes the PS5-compatible argv mode in the PowerShell setup terminal', () => {
    const runtime = { runtime: 'wsl', label: 'WSL' } as const
    const command = buildSkillCommandForRuntime('npx skills update orchestration --global', runtime)
    const setupCommand = buildSkillSetupTerminalCommand(command, 'powershell.exe', runtime, 'win32')

    expect(setupCommand).toMatch(
      /^& \{ \$PSNativeCommandArgumentPassing = 'Legacy'; wsl\.exe --exec sh -c 'sh -c/
    )
    // The command no longer ends in the eval wrapper's nested quotes; it is a
    // plain pipe into sh, so the payload has no quoting layer to escape from.
    expect(setupCommand).toContain('base64 -d)')
  })

  it.skipIf(process.platform === 'win32')(
    'runs skill commands with npx from the configured WSL login-shell PATH',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-wsl-skill-command-'))
      const tools = join(root, 'tools')
      const npxBin = join(root, 'npx-bin')
      const loginShell = join(root, 'zsh')
      mkdirSync(tools)
      mkdirSync(npxBin)
      writeFileSync(
        join(tools, 'getent'),
        '#!/bin/sh\nprintf \'%s\\n\' "user:x:1000:1000::/home/user:$ORCA_TEST_LOGIN_SHELL"\n'
      )
      writeFileSync(
        loginShell,
        '#!/bin/sh\nexport PATH="$ORCA_TEST_NPX_BIN:/usr/bin:/bin"\nexec /bin/sh -c "$2"\n'
      )
      writeFileSync(
        join(npxBin, 'npx'),
        '#!/bin/sh\nread -r input\nprintf \'%s:%s\' "$*" "$input"\n'
      )
      chmodSync(join(tools, 'getent'), 0o755)
      chmodSync(loginShell, 0o755)
      chmodSync(join(npxBin, 'npx'), 0o755)

      try {
        const runtime = {
          runtime: 'wsl',
          label: 'WSL'
        } as const
        const copied = buildSkillCommandForRuntime(
          'npx skills update orchestration --global',
          runtime
        )
        const wrapped = buildSkillSetupTerminalCommand(copied, 'powershell.exe', runtime, 'win32')
        expect(
          execFileSync('/bin/sh', ['-c', getWslOuterShellScript(wrapped)], {
            encoding: 'utf8',
            input: 'terminal-input\n',
            env: {
              ...process.env,
              PATH: `${tools}:/usr/bin:/bin`,
              ORCA_TEST_LOGIN_SHELL: loginShell,
              ORCA_TEST_NPX_BIN: npxBin
            }
          })
        ).toBe('skills update orchestration --global:terminal-input')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('names the CLI each target registers: orca-ide on Linux and WSL, orca elsewhere', () => {
    const installCommand = buildAgentFeatureSkillInstallCommand(['orca-cli', 'orchestration'])
    const host = { runtime: 'host', label: 'This device' } as const
    const wsl = { runtime: 'wsl', wslDistro: 'Ubuntu', label: 'WSL Ubuntu' } as const

    expect(installCommand).toBe('orca skills install --skill orca-cli --skill orchestration')
    expect(buildSkillCommandForRuntime(installCommand, host, 'darwin')).toBe(installCommand)
    expect(buildSkillCommandForRuntime(installCommand, host, 'win32')).toBe(installCommand)
    expect(buildSkillCommandForRuntime(installCommand, undefined, 'win32')).toBe(installCommand)
    expect(buildSkillCommandForRuntime(installCommand, host, 'linux')).toBe(
      'orca-ide skills install --skill orca-cli --skill orchestration'
    )
    expect(buildSkillCommandForRuntime(installCommand, wsl, 'win32')).toBe(
      'orca-ide skills install --skill orca-cli --skill orchestration'
    )
  })

  it('keeps a bare orca while a remote runtime environment is focused', () => {
    const installCommand = buildAgentFeatureSkillInstallCommand(['orchestration'])
    const previous = useAppStore.getState()
    useAppStore.setState({
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'remote-linux' }
    })

    try {
      // The setup terminal runs on that host, whose own Orca terminals resolve `orca`.
      expect(
        buildSkillCommandForRuntime(installCommand, { runtime: 'host', label: 'x' }, 'linux')
      ).toBe(installCommand)
    } finally {
      useAppStore.setState({ settings: previous.settings })
    }
  })

  it('runs the copied Windows host command unchanged in the setup terminal', () => {
    const copied = buildSkillCommandForRuntime(
      buildAgentFeatureSkillInstallCommand(['orchestration']),
      { runtime: 'host', label: 'Windows' },
      'win32'
    )
    expect(buildSkillSetupTerminalCommand(copied, undefined, undefined, 'win32')).toBe(copied)
    expect(buildSkillSetupTerminalCommand(copied, 'powershell.exe', undefined, 'win32')).toBe(
      copied
    )
  })

  it('runs the WSL install through orca-ide inside the selected distro', () => {
    const runtime = { runtime: 'wsl', wslDistro: 'Ubuntu', label: 'WSL Ubuntu' } as const
    const copied = buildSkillCommandForRuntime(
      buildAgentFeatureSkillInstallCommand(['orca-cli']),
      runtime,
      'win32'
    )
    const setupCommand = buildSkillSetupTerminalCommand(copied, 'powershell.exe', runtime, 'win32')
    expect(setupCommand).toContain("wsl.exe -d 'Ubuntu'")
    expect(decodeWslLoginShellScript(setupCommand)).toContain(
      'exec "$_orca_wsl_shell" -ilc \'orca-ide skills install --skill orca-cli\''
    )
  })

  it('adapts bare WSL setup commands to the shell that Orca created', () => {
    const runtime = { runtime: 'wsl', wslDistro: 'Ubuntu', label: 'WSL Ubuntu' } as const
    const skillCommand = 'npx skills add orchestration --global'
    const copiedCommand = buildSkillCommandForRuntime(skillCommand, runtime, 'win32')

    expect(copiedCommand).toBe(skillCommand)
    expect(
      buildSkillSetupTerminalCommand(copiedCommand, 'powershell.exe', runtime, 'win32')
    ).toContain("wsl.exe -d 'Ubuntu'")
    expect(buildSkillSetupTerminalCommand(copiedCommand, 'wsl.exe', runtime, 'win32')).toBe(
      skillCommand
    )
    expect(
      buildSkillSetupTerminalCommand(
        'npx skills add orchestration --global',
        undefined,
        undefined,
        'linux'
      )
    ).toBe('npx skills add orchestration --global')
  })

  it('preserves the exact WSL script when adapting setup-terminal auto-paste', () => {
    const skillCommand = "printf 'héllo\n# Runs: unchanged'"
    const runtime = {
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      label: 'WSL Ubuntu'
    } as const
    const copiedCommand = buildSkillCommandForRuntime(skillCommand, runtime)
    const powershellCommand = buildSkillSetupTerminalCommand(
      copiedCommand,
      'powershell.exe',
      runtime,
      'win32'
    )

    expect(buildSkillSetupTerminalCommand(powershellCommand, 'wsl.exe', runtime, 'win32')).toBe(
      buildWslLoginShellCommand(skillCommand)
    )
  })

  it('does not wrap unrelated Windows host commands', () => {
    expect(
      buildSkillCommandForRuntime(
        'orca skills list',
        {
          runtime: 'host',
          label: 'Windows'
        },
        'win32'
      )
    ).toBe('orca skills list')
  })

  it('forces PowerShell for the skill terminal when Windows runs a POSIX-family shell', () => {
    const hostRuntime = { runtime: 'host', label: 'Windows' } as const
    const overrideFor = (terminalWindowsShell: string): string | undefined =>
      getAgentSkillTerminalShellOverride(
        'win32',
        { ...getDefaultSettings('/tmp'), terminalWindowsShell },
        hostRuntime
      )

    // Git Bash rewrites the leading /d /s /c arguments as MSYS paths.
    expect(overrideFor('git-bash')).toBe('powershell.exe')
    expect(overrideFor('wsl.exe')).toBe('powershell.exe')
    expect(overrideFor('cmd.exe')).toBeUndefined()
    expect(overrideFor('powershell.exe')).toBeUndefined()
  })

  it('preserves the selected WSL distro for skill discovery', () => {
    expect(
      getSkillDiscoveryTargetForRuntime({
        runtime: 'wsl',
        wslDistro: 'Ubuntu',
        label: 'WSL Ubuntu'
      })
    ).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('uses the global project runtime default instead of stale WSL agent location', () => {
    expect(
      getSelectedAgentRuntime(
        {
          ...getDefaultSettings('/tmp'),
          localAgentRuntime: 'wsl',
          localAgentWslDistro: 'Debian',
          terminalWindowsShell: 'wsl.exe',
          terminalWindowsWslDistro: 'Debian',
          localWindowsRuntimeDefault: { kind: 'windows-host' }
        },
        true,
        true,
        false
      )
    ).toMatchObject({ runtime: 'host' })
  })

  it('uses the WSL global project runtime default instead of stale host agent location', () => {
    expect(
      getSelectedAgentRuntime(
        {
          ...getDefaultSettings('/tmp'),
          localAgentRuntime: 'host',
          terminalWindowsShell: 'powershell.exe',
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
        },
        true,
        true,
        false
      )
    ).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu', label: 'WSL Ubuntu' })
  })
})
