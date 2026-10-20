import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
const capture = vi.hoisted(() => vi.fn())
vi.mock('../claude/claude-hook-target', () => ({ resolveSystemClaudeHookTarget: capture }))
import { provisionWslClaudeAccountProfile } from './claude-profile-wsl-setup'

it.skipIf(process.platform === 'win32')(
  'copies WSL profile settings from the guest shell root',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wsl-profile-root-')))
    try {
      const userHome = join(root, 'home')
      const custom = join(root, 'custom')
      mkdirSync(userHome)
      mkdirSync(custom)
      writeFileSync(join(custom, 'settings.json'), '{"model":"opus"}')
      capture.mockResolvedValue({ kind: 'system-default', configDir: custom })
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
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
