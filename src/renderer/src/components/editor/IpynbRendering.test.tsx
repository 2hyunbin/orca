// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IpynbCellOutputs } from './IpynbCellOutputs'
import { IpynbCellSource, IpynbMarkdownCell } from './IpynbCellEditor'
import { IpynbRunPrompt } from './IpynbCellToolbar'
import { TooltipProvider } from '@/components/ui/tooltip'
import * as tail from './ipynb-output-tail'
import { applyKernelOutput, type LiveOutputs } from './ipynb-kernel-outputs'
import * as ansi from './ipynb-ansi'
import { parseIpynbOutput, type IpynbCell, type IpynbOutput } from './ipynb-parse'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/hooks/use-document-dark-theme', () => ({ useDocumentDarkTheme: () => true }))
vi.mock('@/lib/monaco-setup', () => ({ monaco: {} }))
vi.mock('./MonacoCodeExcerpt', () => ({
  useMonacoColorizedLines: () => []
}))

function cell(kind: IpynbCell['kind'], source: string, outputs: IpynbOutput[] = []): IpynbCell {
  return { id: 'cell-1', kind, language: 'python', source, executionCount: 1, outputs }
}

function renderSource(target: IpynbCell, onActivate = vi.fn()) {
  render(
    <IpynbCellSource
      cell={target}
      source={target.source}
      active={false}
      onActivate={onActivate}
      onDeactivate={vi.fn()}
      onChange={vi.fn()}
    />
  )
  return onActivate
}

afterEach(cleanup)

describe('notebook cell source', () => {
  it('renders markdown through the full preview pipeline (GFM + math)', () => {
    render(<IpynbMarkdownCell source={'| A | B |\n| - | - |\n| 1 | 2 |\n\n$x^2$'} />)
    expect(document.querySelector('table')).not.toBeNull()
    expect(document.querySelector('.katex')).not.toBeNull()
  })

  it('shows markdown as a document and edits only on double-click or Enter', () => {
    const onActivate = renderSource(cell('markdown', '# Report'))
    const preview = screen.getByRole('button')
    expect(screen.getByRole('heading', { name: 'Report' })).toBeTruthy()

    fireEvent.click(preview)
    expect(onActivate).not.toHaveBeenCalled()
    fireEvent.doubleClick(preview)
    fireEvent.keyDown(preview, { key: 'Enter' })
    expect(onActivate).toHaveBeenCalledTimes(2)
  })

  it('activates code cells on primary press so a collapsing neighbour cannot swallow the click', () => {
    const onActivate = renderSource(cell('code', 'print(1)'))
    const preview = screen.getByRole('button')
    fireEvent.mouseDown(preview, { button: 2 })
    expect(onActivate).not.toHaveBeenCalled()
    fireEvent.mouseDown(preview, { button: 0 })
    expect(onActivate).toHaveBeenCalledOnce()
  })
})

describe('notebook code preview', () => {
  it('shows source as literal text until Monaco colorizes it', () => {
    renderSource(cell('code', 'x = "<b>hi</b>"\n'))
    expect(screen.getByText('x = "<b>hi</b>"')).toBeTruthy()
    expect(document.querySelector('b')).toBeNull()
    // The trailing newline keeps its own row, matching the Monaco model.
    expect(document.querySelectorAll('code')).toHaveLength(2)
  })
})

describe('notebook run prompt', () => {
  it('shows the count, then [*] with a disabled button while queued or running, then the duration', () => {
    const { rerender } = render(
      <IpynbRunPrompt executionCount={3} state="idle" duration={null} onRun={vi.fn()} />,
      { wrapper: TooltipProvider }
    )
    expect(screen.getByText('[3]')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Run cell' }).hasAttribute('disabled')).toBe(false)

    for (const state of ['queued', 'running'] as const) {
      rerender(<IpynbRunPrompt executionCount={3} state={state} duration={null} onRun={vi.fn()} />)
      expect(screen.getByText('[*]')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Run cell' }).hasAttribute('disabled')).toBe(true)
    }

    rerender(<IpynbRunPrompt executionCount={4} state="idle" duration="1.2s" onRun={vi.fn()} />)
    expect(screen.getByText('[4]')).toBeTruthy()
    expect(screen.getByText('1.2s')).toBeTruthy()
  })
})

describe('notebook outputs', () => {
  it.each([false, true])('keeps DOM and ANSI through CR and LF (chain: %s)', (chain) => {
    let live: LiveOutputs = { outputs: [], clearOnNextOutput: false }
    const view = render(<IpynbCellOutputs cell={cell('code', '')} />)
    const update = (text: string): void => {
      live = applyKernelOutput(live, 'stream', { name: 'stdout', text })
      const output = parseIpynbOutput(live.outputs[0])
      if (!output || output.kind !== 'stream') {
        throw new Error('Missing stream')
      }
      view.rerender(<IpynbCellOutputs cell={cell('code', '', [output])} />)
      expect(output.drawn.text).toBe(tail.drawnTail(String(live.outputs[0]?.text)).text)
      expect(output.drawn.text.length).toBeLessThanOrEqual(tail.DRAWN_OUTPUT_CHARS)
    }
    const completed = chain
      ? `${'x'.repeat(8191)}${`\u001b[31m${'x'.repeat(8187)}`.repeat(2)}\u001b]title\n`
      : `\u001b[31m${'x'.repeat(4090)}\n`.repeat(260)
    update(`${completed}${chain ? '\u0007' : ''}1%`)
    const spans = [...document.querySelectorAll('pre span')]
    const interior = spans[Math.floor(spans.length / 2)]
    const red = interior?.getAttribute('style')
    const stable = chain ? spans.filter((span) => span.textContent?.includes('x')) : [interior]
    if (chain) {
      expect(stable.map((span) => span.textContent).join('')).toBe('x'.repeat(24565))
    }
    const parse = vi.spyOn(ansi, 'parseAnsiBlock')
    const ranges = vi.spyOn(ansi, 'ansiBlockRanges')
    try {
      for (const text of ['\r20%', '\r\u001b[32m30%', '\r4%', '\nnext']) {
        update(chain ? text.replace('\r', '\r\u0007') : text)
      }
      expect(stable.every((span) => span?.isConnected)).toBe(true)
      expect(document.querySelector('pre span:last-child')?.getAttribute('style')).toBe(red)
      const parseSizes = parse.mock.calls.map(([input]) => input.length)
      const rangeSizes = ranges.mock.calls.map(([input]) => input.length)
      for (const sizes of [parseSizes, rangeSizes]) {
        expect(Math.max(...sizes)).toBeLessThanOrEqual(chain ? 17 : 8192)
      }
    } finally {
      parse.mockRestore()
      ranges.mockRestore()
    }
  })

  it('renders only the richest representation of a display bundle', () => {
    render(
      <IpynbCellOutputs
        cell={cell('code', 'df', [
          {
            kind: 'display',
            outputType: 'execute_result',
            executionCount: 1,
            items: [
              { mime: 'text/html', value: '<table><tr><td>rich</td></tr></table>' },
              { mime: 'text/plain', value: 'plain fallback' }
            ]
          }
        ])}
      />
    )
    expect(screen.getByTitle('Notebook HTML output').getAttribute('srcdoc')).toContain('rich')
    expect(screen.queryByText('plain fallback')).toBeNull()
  })

  it('skips MIME types it cannot render in favour of the text fallback', () => {
    render(
      <IpynbCellOutputs
        cell={cell('code', 'w', [
          {
            kind: 'display',
            outputType: 'display_data',
            executionCount: null,
            items: [
              { mime: 'application/vnd.custom-widget', value: {} },
              { mime: 'text/plain', value: 'widget repr' }
            ]
          }
        ])}
      />
    )
    expect(screen.getByText('widget repr')).toBeTruthy()
  })

  it('colours ANSI tracebacks instead of printing escape codes', () => {
    render(
      <IpynbCellOutputs
        cell={cell('code', '1/0', [
          {
            kind: 'error',
            name: 'ZeroDivisionError',
            message: 'division by zero',
            drawn: {
              text: '\u001b[0;31mZeroDivisionError\u001b[0m: division by zero',
              truncated: false
            }
          }
        ])}
      />
    )
    const name = screen.getByText('ZeroDivisionError')
    expect(name.tagName).toBe('SPAN')
    expect(name.style.color).not.toBe('')
    expect(document.body.textContent).not.toContain('\u001b')
  })

  it('bounds outputs while keeping the latest traceback and final kernel detail in order', () => {
    const long = parseIpynbOutput({
      output_type: 'stream',
      name: 'stdout',
      text: Array.from({ length: tail.DRAWN_OUTPUT_LINES + 1 }, (_, index) => `line ${index}\n`)
    })
    const short = Array.from({ length: tail.DRAWN_OUTPUTS_PER_CELL }, (): IpynbOutput => ({
      kind: 'stream',
      name: 'stdout',
      drawn: { text: 'x', truncated: false }
    }))
    const error = parseIpynbOutput({ output_type: 'error', traceback: ['final traceback'] })
    const final = parseIpynbOutput({
      output_type: 'display_data',
      data: { 'text/markdown': 'Kernel stopped\n\n```\nexit detail\n```' }
    })
    if (!long || !error || !final) {
      throw new Error('Missing stream output')
    }
    const outputs = [long, ...short, error, ...short.slice(0, 12), final]
    render(<IpynbCellOutputs cell={cell('code', 'spam()', outputs)} />)
    const pres = document.querySelectorAll('pre')
    expect(pres).toHaveLength(tail.DRAWN_OUTPUTS_PER_CELL)
    expect(pres[0]?.textContent?.startsWith('line 1\n')).toBe(true)
    expect(pres[0]?.previousElementSibling?.textContent).toBe('Earlier output is hidden.')
    expect(screen.getByText('{{count}} more outputs are hidden.')).toBeTruthy()
    expect(screen.getByText('final traceback')).toBeTruthy()
    expect([...pres].at(-1)?.textContent).toContain('exit detail')
  })

  it('sandboxes HTML output behind a no-network CSP and strips scripts', () => {
    render(
      <IpynbCellOutputs
        cell={cell('code', 'html', [
          {
            kind: 'display',
            outputType: 'display_data',
            executionCount: null,
            items: [{ mime: 'text/html', value: '<script>alert(1)</script><b>safe</b>' }]
          }
        ])}
      />
    )
    const frame = screen.getByTitle('Notebook HTML output')
    const source = frame.getAttribute('srcdoc') ?? ''
    // An empty sandbox keeps the frame an opaque origin with scripts off.
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(source).toContain("default-src 'none'; img-src data:")
    expect(source).not.toContain('<script')
    expect(source).toContain('<b>safe</b>')
  })
})
