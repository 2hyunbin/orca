import { describe, expect, it } from 'vitest'
import type { KernelOutputType } from '../../../../shared/notebook-kernel-types'
import { applyKernelOutput, toStoredOutputs, type LiveOutputs } from './ipynb-kernel-outputs'

const EMPTY: LiveOutputs = { outputs: [], clearOnNextOutput: false }
const MAX_STREAM_CHARS = 2 * 1024 * 1024
const MAX_OUTPUT_CHARS = 16 * 1024 * 1024
const NOTICE = {
  output_type: 'display_data',
  data: {
    'text/markdown':
      'Output truncated: this cell produced more output than Orca keeps, so the rest is not shown.'
  },
  metadata: {}
}

function apply(messages: [KernelOutputType, Record<string, unknown>][], live = EMPTY): LiveOutputs {
  return messages.reduce(
    (current, [type, content]) => applyKernelOutput(current, type, content),
    live
  )
}

// 2.5 MiB of stdout in 64 KiB chunks.
function flood(): LiveOutputs {
  const chunk = 'x'.repeat(64 * 1024)
  return apply(Array.from({ length: 40 }, () => ['stream', { name: 'stdout', text: chunk }]))
}

function textOf(live: LiveOutputs, index: number): string {
  return String(live.outputs[index]?.text)
}

describe('applyKernelOutput output budget', () => {
  it('keeps the first 2 MiB of stream text, then one notice, and drops later stream chunks', () => {
    const live = flood()
    expect(live.outputs).toHaveLength(2)
    expect(textOf(live, 0)).toBe('x'.repeat(MAX_STREAM_CHARS))
    expect(live.outputs[1]).toEqual(NOTICE)

    const after = apply(
      [
        ['stream', { name: 'stdout', text: 'more' }],
        ['stream', { name: 'stderr', text: 'warn' }],
        ['display_data', { data: { 'text/plain': 'late' }, metadata: {} }]
      ],
      live
    )
    expect(after).toBe(live)
  })

  it('shares the stream budget across stdout and stderr', () => {
    const half = 'y'.repeat(MAX_STREAM_CHARS / 2)
    const live = apply([
      ['stream', { name: 'stdout', text: half }],
      ['stream', { name: 'stderr', text: half }],
      ['stream', { name: 'stdout', text: 'over' }]
    ])
    expect(live.outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: half },
      { output_type: 'stream', name: 'stderr', text: half },
      NOTICE
    ])
  })

  it('always keeps errors and the execution result after truncation, and saves what was shown', () => {
    const live = apply(
      [
        ['execute_result', { execution_count: 4, data: { 'text/plain': '42' }, metadata: {} }],
        ['error', { ename: 'KeyboardInterrupt', evalue: '', traceback: ['tb'] }]
      ],
      flood()
    )
    expect(toStoredOutputs(live.outputs)).toEqual([
      { output_type: 'stream', name: 'stdout', text: 'x'.repeat(MAX_STREAM_CHARS) },
      NOTICE,
      {
        output_type: 'execute_result',
        execution_count: 4,
        data: { 'text/plain': '42' },
        metadata: {}
      },
      { output_type: 'error', ename: 'KeyboardInterrupt', evalue: '', traceback: ['tb'] }
    ])
  })

  it('counts only retained text, so a long progress bar rewritten with \\r is never truncated', () => {
    const frames: [KernelOutputType, Record<string, unknown>][] = []
    for (let step = 0; step < 50_000; step += 1) {
      frames.push(['stream', { name: 'stderr', text: `\r${String(step).padStart(80, '#')}` }])
    }
    const live = apply(frames)
    expect(live.outputs).toEqual([
      { output_type: 'stream', name: 'stderr', text: String(49_999).padStart(80, '#') }
    ])
  })

  it('starts a fresh budget after clear_output, immediate or wait=True', () => {
    const cleared = apply(
      [
        ['clear_output', { wait: false }],
        ['stream', { name: 'stdout', text: 'fresh' }]
      ],
      flood()
    )
    expect(cleared.outputs).toEqual([{ output_type: 'stream', name: 'stdout', text: 'fresh' }])

    const waited = apply(
      [
        ['clear_output', { wait: true }],
        ['stream', { name: 'stdout', text: 'fresh' }]
      ],
      flood()
    )
    expect(waited.outputs).toEqual([{ output_type: 'stream', name: 'stdout', text: 'fresh' }])
  })

  it('caps a cell at 500 outputs', () => {
    const frames: [KernelOutputType, Record<string, unknown>][] = []
    for (let index = 0; index < 600; index += 1) {
      frames.push(['display_data', { data: { 'text/plain': String(index) }, metadata: {} }])
    }
    const live = apply(frames)
    expect(live.outputs).toHaveLength(501)
    expect(live.outputs[499]).toEqual({
      output_type: 'display_data',
      data: { 'text/plain': '499' },
      metadata: {}
    })
    expect(live.outputs[500]).toEqual(NOTICE)
  })

  it('drops rich outputs past 16 MiB but still updates displays already shown', () => {
    const image = 'A'.repeat(1024 * 1024)
    const frames: [KernelOutputType, Record<string, unknown>][] = [
      [
        'display_data',
        { data: { 'text/plain': '0%' }, metadata: {}, transient: { display_id: 'p' } }
      ]
    ]
    for (let index = 0; index < 30; index += 1) {
      frames.push(['display_data', { data: { 'image/png': image }, metadata: {} }])
    }
    const live = apply(frames)
    expect(live.outputs.at(-1)).toEqual(NOTICE)
    const kept = JSON.stringify(live.outputs.map((output) => output.data)).length
    expect(kept).toBeLessThanOrEqual(MAX_OUTPUT_CHARS)
    expect(live.outputs.length).toBeGreaterThan(10)

    const updated = applyKernelOutput(live, 'update_display_data', {
      data: { 'text/plain': '100%' },
      metadata: {},
      transient: { display_id: 'p' }
    })
    expect(updated.outputs[0]?.data).toEqual({ 'text/plain': '100%' })
  })

  it('does not split a surrogate pair at the cut', () => {
    const live = apply([
      ['stream', { name: 'stdout', text: 'x'.repeat(MAX_STREAM_CHARS - 1) }],
      ['stream', { name: 'stdout', text: '\u{1F680}tail' }]
    ])
    expect(textOf(live, 0)).toBe('x'.repeat(MAX_STREAM_CHARS - 1))
    expect(live.outputs[1]).toEqual(NOTICE)
  })
})
