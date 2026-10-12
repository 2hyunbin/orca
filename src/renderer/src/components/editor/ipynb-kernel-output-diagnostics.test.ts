import { describe, expect, it } from 'vitest'
import { applyKernelOutput, toStoredOutputs, type LiveOutputs } from './ipynb-kernel-outputs'

const LIMIT = 16 * 1024 * 1024
const TEXT_LIMIT = 2 * 1024 * 1024
const EMPTY: LiveOutputs = { outputs: [], clearOnNextOutput: false }
const noticeCount = (live: LiveOutputs) =>
  live.outputs.filter((output) => JSON.stringify(output.data ?? null).includes('Output truncated:'))
    .length
const result = (live: LiveOutputs, text: string, metadata = {}) =>
  applyKernelOutput(live, 'execute_result', {
    execution_count: 3,
    data: { 'text/plain': text },
    metadata
  })

describe('notebook finite first diagnostics', () => {
  it('keeps a bounded first result and error after ordinary output fills', () => {
    let live = applyKernelOutput(EMPTY, 'stream', {
      name: 'stdout',
      text: 'x'.repeat(3 * 1024 * 1024)
    })
    live = result(live, 'done')
    live = applyKernelOutput(live, 'error', {
      ename: 'KeyboardInterrupt',
      evalue: '',
      traceback: ['tb']
    })
    expect(live.outputs.map((output) => output.output_type)).toEqual([
      'stream',
      'display_data',
      'execute_result',
      'error'
    ])
    expect(noticeCount(live)).toBe(1)
  })

  it('bounds a huge first result and keeps its text and execution count', () => {
    const live = result(EMPTY, 'r'.repeat(LIMIT * 2))
    const data = live.outputs[0]?.data
    expect(JSON.stringify(data).length).toBeLessThan(TEXT_LIMIT + 1024)
    expect(live.outputs[0]?.execution_count).toBe(3)
    expect(JSON.stringify(data).startsWith('{"text/plain":"rrrr')).toBe(true)
    expect(noticeCount(live)).toBe(1)
    expect(JSON.stringify(toStoredOutputs(live.outputs)).length).toBeLessThan(TEXT_LIMIT + 1024)
  })

  it('charges diagnostic metadata and leaves binary-only results empty with a notice', () => {
    const hugeMetadata = result(EMPTY, '42', { custom: 'm'.repeat(LIMIT) })
    expect(hugeMetadata.outputs[0]?.data).toEqual({ 'text/plain': '42' })
    expect(hugeMetadata.outputs[0]?.metadata).toEqual({})
    expect(noticeCount(hugeMetadata)).toBe(1)
    const image = applyKernelOutput(EMPTY, 'execute_result', {
      execution_count: 4,
      data: { 'image/png': 'A'.repeat(LIMIT) },
      metadata: {}
    })
    expect(image.outputs[0]?.data).toEqual({ 'text/plain': '' })
    expect(noticeCount(image)).toBe(1)
  })

  it('uses textual MIME fallback without cutting an emoji in half', () => {
    const live = applyKernelOutput(EMPTY, 'execute_result', {
      data: { 'text/markdown': `${'x'.repeat(TEXT_LIMIT - 1)}😀${'y'.repeat(LIMIT)}` },
      metadata: {}
    })
    expect(JSON.stringify(live.outputs[0]?.data).endsWith('x"}')).toBe(true)
    expect(JSON.stringify(live.outputs[0]?.data).length).toBe(TEXT_LIMIT - 1 + 17)
  })

  it('bounds error name, value, and traceback together and preserves useful details', () => {
    const live = applyKernelOutput(EMPTY, 'error', {
      ename: 'ValueError',
      evalue: 'bad input',
      traceback: ['Traceback', 'z'.repeat(LIMIT * 2)]
    })
    expect(live.outputs[0]?.ename).toBe('ValueError')
    expect(live.outputs[0]?.evalue).toBe('bad input')
    expect(JSON.stringify(live.outputs[0]?.traceback).startsWith('["Traceback\\nzzzz')).toBe(true)
    expect(JSON.stringify(live.outputs).length).toBeLessThan(TEXT_LIMIT + 1024)
    expect(noticeCount(live)).toBe(1)
  })

  it('charges large error values and names even when the traceback is empty', () => {
    const live = applyKernelOutput(EMPTY, 'error', {
      ename: 'E'.repeat(LIMIT),
      evalue: 'v'.repeat(LIMIT),
      traceback: []
    })
    expect(String(live.outputs[0]?.ename).length).toBe(1024)
    expect(String(live.outputs[0]?.evalue).length).toBe(64 * 1024)
    expect(noticeCount(live)).toBe(1)
    expect(JSON.stringify(live.outputs).length).toBeLessThan(TEXT_LIMIT + 1024)
  })

  it('budgets repeated errors before truncation instead of giving each one an exception', () => {
    let live = EMPTY
    for (let index = 0; index < 5; index += 1) {
      live = applyKernelOutput(live, 'error', {
        ename: 'E',
        evalue: 'e'.repeat(9 * 1024 * 1024),
        traceback: []
      })
    }
    expect(live.outputs.map((output) => output.output_type)).toEqual([
      'error',
      'error',
      'display_data'
    ])
    expect(noticeCount(live)).toBe(1)
  })

  it.each([false, true])('renews the diagnostic allowance after clear wait=%s', (wait) => {
    const capped = result(EMPTY, 'x'.repeat(LIMIT * 2))
    const cleared = applyKernelOutput(capped, 'clear_output', { wait })
    const fresh = result(cleared, 'fresh')
    expect(fresh.outputs).toHaveLength(1)
    expect(fresh.outputs[0]?.data).toEqual({ 'text/plain': 'fresh' })
    expect(noticeCount(fresh)).toBe(0)
  })
})
