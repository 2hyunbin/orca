import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as os from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
const capture = vi.hoisted(() => vi.fn())
const guestHome = vi.hoisted(() => vi.fn())
vi.mock('node:os', async (original) => ({
  ...(await original<typeof os>()),
  homedir: guestHome
}))
vi.mock('../startup/login-shell-environment', () => ({ resolveLoginShellEnvironment: capture }))
import { provisionWslClaudeAccountProfile } from './claude-profile-wsl-setup'

it.skipIf(process.platform === 'win32').each(['unset', 'explicit-default', 'custom'])(
  'copies WSL settings and global state with a %s guest override',
  async (override) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wsl-profile-root-')))
    try {
      const userHome = join(root, 'home')
      guestHome.mockReturnValue(userHome)
      const custom = override === 'custom' ? join(root, 'custom') : join(userHome, '.claude')
      mkdirSync(userHome)
      mkdirSync(custom)
      writeFileSync(join(custom, 'settings.json'), '{"model":"opus"}')
      writeFileSync(
        join(userHome, '.claude.json'),
        '{"hasCompletedOnboarding":true,"theme":"light"}'
      )
      writeFileSync(join(custom, '.claude.json'), '{"hasCompletedOnboarding":true,"theme":"dark"}')
      capture.mockResolvedValue(override === 'unset' ? {} : { CLAUDE_CONFIG_DIR: custom })
      const report = await provisionWslClaudeAccountProfile(userHome, 'Ubuntu', 'test')
      expect(report.outcome).toBe('prepared')
      expect(
        JSON.parse(
          readFileSync(
            join(userHome, '.local/share/orca/claude-profiles/test/home/settings.json'),
            'utf8'
          )
        )
      ).toEqual({ model: 'opus' })
      expect(
        JSON.parse(
          readFileSync(
            join(userHome, '.local/share/orca/claude-profiles/test/home/.claude.json'),
            'utf8'
          )
        )
      ).toMatchObject({
        hasCompletedOnboarding: true,
        theme: override === 'unset' ? 'light' : 'dark'
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
