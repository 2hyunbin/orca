import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentTypeIcon } from './agent-type-icon'
import { normalizeProgramId } from './program-icon'

function render(agentType: string | null | undefined): string {
  return renderToStaticMarkup(<AgentTypeIcon agentType={agentType} />)
}

describe('AgentTypeIcon', () => {
  it('renders the brand glyph for a curated program', () => {
    expect(render('brew')).toContain('data-program-glyph="homebrew"')
    expect(render('Cargo')).toContain('data-program-glyph="rust"')
  })

  it('renders a category icon for long-tail programs', () => {
    expect(render('make')).toContain('lucide-hammer')
  })

  it('falls back to the first alphanumeric letter for unrecognized programs', () => {
    expect(render('zzz-tool')).toContain('>Z</text>')
    expect(render('_9tool')).toContain('>9</text>')
  })

  it('keeps "?" for unidentified agents', () => {
    expect(render('unknown')).toContain('>?</text>')
    expect(render(null)).toContain('>?</text>')
    expect(render(undefined)).toContain('>?</text>')
  })

  it('still renders the Claude icon for known agents', () => {
    const markup = render('claude')
    expect(markup).toContain('#D97757')
    expect(markup).not.toContain('data-program-glyph')
  })
})

describe('normalizeProgramId', () => {
  it('lowercases and strips trailing version suffixes', () => {
    expect(normalizeProgramId('Python-3.12')).toBe('python')
    expect(normalizeProgramId('node@20')).toBe('node')
    expect(normalizeProgramId('pip3.11')).toBe('pip3')
    expect(normalizeProgramId('redis-cli')).toBe('redis-cli')
    expect(normalizeProgramId('k9s')).toBe('k9s')
  })

  it('strips a bare trailing version only when that names a known program', () => {
    expect(normalizeProgramId('go1.21')).toBe('go')
    expect(normalizeProgramId('python311')).toBe('python')
    expect(normalizeProgramId('sqlite3')).toBe('sqlite3')
    expect(normalizeProgramId('s3')).toBe('s3')
  })
})
