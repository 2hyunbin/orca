import { describe, expect, it } from 'vitest'
import { parseAnsiSegments } from '../renderer/src/components/editor/ipynb-ansi'
import { restoredSnapshotPaintsPrintableContent } from '../renderer/src/components/terminal-pane/restored-snapshot-coverage'
import { parseCodexLoginAuthUrl } from '../main/codex-accounts/codex-login-auth-url'
import { TerminalCommandPaint } from '../main/runtime/terminal-command-paint'
import { claudePermissionSubject } from '../main/claude/claude-permission-presentation'
import { terminalSafe } from '../cli/agent-session-search-format'
import { gitLabJobTraceToLogExcerpt } from './gitlab-job-log-excerpt'
import { surfaceNativeChatCommandOutputs } from './native-chat-command-output'
import type { NativeChatMessage } from './native-chat-types'
import { normalizeNativeChatUserText } from './native-chat-image-transcript-markers'
import { createAutomationRunOutputSnapshotBuffer } from '../renderer/src/components/automations/automation-run-output-snapshot'

const mixed = '\x1bPleft\x1b]hidden\x1b\\right\x1b\\KEEP'

describe('ANSI consumer compatibility with independent literal oracles', () => {
  it('preserves notebook malformed 8-bit and unrelated controls', () => {
    expect(parseAnsiSegments('\x9dunfinished')).toEqual([{ text: '\x9dunfinished' }])
    expect(parseAnsiSegments('\x00\t\r\n\x85')).toEqual([{ text: '\x00\t\r\n\x85' }])
    expect(parseAnsiSegments(mixed)).toEqual([{ text: 'KEEP' }])
  })
  it('keeps GitLab visible CR section headers after ANSI stripping', () => {
    expect(
      gitLabJobTraceToLogExcerpt(
        `section_start:123:test\r\x1b[0KHeader\n${mixed}\nsection_end:124:test\r\x1b[0K\n`
      )
    ).toBe('Header\nKEEP')
  })
  it('requires a complete Codex URL terminated by whitespace', () => {
    const prefix = `${mixed}\nNavigate to this URL to authenticate: `
    expect(
      parseCodexLoginAuthUrl(`${prefix}https://auth.example.test/path?state=public`)
    ).toBeNull()
    expect(
      parseCodexLoginAuthUrl(
        `${prefix}\x1b[32mhttps://auth.example.test/path?state=public\x1b[0m\n`
      )
    ).toBe('https://auth.example.test/path?state=public')
  })
  it('keeps terminal-safe CLI and permission text literal', () => {
    expect(terminalSafe(`\x00${mixed}\r\n\t\x85`)).toBe('KEEP\r\n\t')
    expect(claudePermissionSubject('ExitPlanMode', { plan: `\x00${mixed}\x85` })).toEqual({
      kind: 'plan',
      text: 'KEEP'
    })
  })
  it('distinguishes control-only snapshots and command paint from visible text', () => {
    const invisible = '\x1b]title\x07\x1b[0m\x00\x85 \n'
    expect(restoredSnapshotPaintsPrintableContent({ data: invisible })).toBe(false)
    expect(restoredSnapshotPaintsPrintableContent({ scrollbackAnsi: mixed })).toBe(true)
    const paint = new TerminalCommandPaint()
    paint.observe('\x1b]133;C\x07', '')
    paint.observe(invisible, invisible)
    expect(paint.hasPainted()).toBe(false)
    paint.observe(mixed, mixed)
    expect(paint.hasPainted()).toBe(true)
  })
  it('surfaces ordered stripped command output', () => {
    const rows: NativeChatMessage[] = [
      {
        id: 'parent',
        role: 'user',
        timestamp: 100,
        source: 'transcript',
        blocks: [
          {
            type: 'text',
            text: '<command-name>/context</command-name><command-message>context</command-message>'
          }
        ]
      },
      {
        id: 'reply',
        parentId: 'parent',
        role: 'user',
        timestamp: 100,
        source: 'transcript',
        blocks: [{ type: 'text', text: `<local-command-stdout>${mixed}</local-command-stdout>` }]
      }
    ]
    expect(surfaceNativeChatCommandOutputs(rows, 'openclaude')[1]?.blocks).toEqual([
      { type: 'text', text: 'KEEP', presentation: 'command-output' }
    ])
  })
  it('preserves pending echo and automation snapshots with literal oracles', () => {
    expect(normalizeNativeChatUserText(`\x00${mixed}\r\n\tword`)).toBe('KEEP word')
    const output = createAutomationRunOutputSnapshotBuffer()
    output.append(`\x00${mixed}\r\n\tword\x85`)
    expect(output.snapshot()).toMatchObject({
      format: 'plain_text',
      content: 'KEEP\n\tword',
      truncated: false
    })
  })
})
