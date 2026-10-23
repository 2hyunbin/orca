import { describe, expect, it } from 'vitest'
import { normalizeCrlfLineEndings } from './normalize-crlf-line-endings'
import { cleanGeneratedCommitMessage } from './commit-message-agent-output'
import { buildPosixRunnerScript } from '../main/setup-runner-script-text'

describe('CRLF normalization', () => {
  it.each(['', 'plain\ntext', '\r', '\r\n', '\r\r\n\n\r', '😀\r\n\ud800\r\u2028\u2029'])(
    'preserves every character except the CR in each CRLF pair: %j',
    (text) => {
      expect(normalizeCrlfLineEndings(text)).toBe(text.replaceAll('\r\n', '\n'))
    }
  )

  it.each([65_534, 65_535, 65_536, 65_537])(
    'preserves CRLF pairs and Unicode at a dense window boundary after %i code units',
    (length) => {
      const prefix = '\r\n'.repeat(4096)
      const text = `${prefix}${'a'.repeat(length)}\r\n😀\r\ud800\n${'b\r\n'.repeat(30_000)}end\r`
      expect(normalizeCrlfLineEndings(text)).toBe(text.replaceAll('\r\n', '\n'))
    }
  )

  it('preserves complete runner and generated-message cleanup across dense text', () => {
    const body = `${'a\r\n'.repeat(100_000)}tail\rinside 😀\ud800`
    const normalized = body.replaceAll('\r\n', '\n')
    expect(
      cleanGeneratedCommitMessage(
        `Generating…\r\n<think>reason</think>\r\n\`\`\`text\r\n${body}\r\n\`\`\``
      )
    ).toBe(normalized)
    expect(buildPosixRunnerScript(`#!/usr/bin/env -S bash -euo pipefail\r\n${body}`)).toBe(
      `#!/usr/bin/env bash\nset -e\nset -euo pipefail\n${normalized}\n`
    )
  })
})
