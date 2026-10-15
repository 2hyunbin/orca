import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  deleteIpynbCell,
  insertIpynbCell,
  moveIpynbCell,
  clearIpynbOutputs,
  serializeIpynbDocument,
  updateIpynbCellKind,
  updateIpynbCodeCell,
  updateIpynbCellSource,
  withIpynbCellIds
} from './ipynb-cell-mutations'
import {
  concatIpynbMultilineString,
  parseIpynb,
  parseIpynbDocument,
  translateKernelLanguageToMonaco,
  type IpynbDocument
} from './ipynb-parse'

/** Applies a document change to notebook text and returns the saved JSON. */
function edited(content: string, change: (document: IpynbDocument) => IpynbDocument) {
  return JSON.parse(serializeIpynbDocument(change(parseIpynbDocument(content))))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ipynb parsing', () => {
  it('normalizes multiline strings like VS Code notebooks', () => {
    expect(concatIpynbMultilineString(['a', 'b\n', 'c\r\n'])).toBe('a\nb\nc\n')
  })

  it('maps Jupyter kernel language names to Monaco language ids', () => {
    expect(translateKernelLanguageToMonaco('c#')).toBe('csharp')
    expect(translateKernelLanguageToMonaco('c++11')).toBe('cpp')
    expect(translateKernelLanguageToMonaco('python')).toBe('python')
  })

  it('parses cells, metadata, and common output types', () => {
    const notebook = parseIpynb(
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
          kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
          language_info: { name: 'python' }
        },
        cells: [
          {
            id: 'intro',
            cell_type: 'markdown',
            source: ['# Hello', ' notebook'],
            metadata: {}
          },
          {
            id: 'code',
            cell_type: 'code',
            execution_count: 7,
            source: ['print("hi")\n'],
            metadata: { vscode: { languageId: 'python' } },
            outputs: [
              { output_type: 'stream', name: 'stdout', text: ['hi\n'] },
              {
                output_type: 'execute_result',
                execution_count: 7,
                data: { 'text/plain': '7', 'text/html': '<b>7</b>' },
                metadata: {}
              }
            ]
          }
        ]
      })
    )

    expect(notebook.cells).toHaveLength(2)
    expect(notebook.cells[0]).toMatchObject({
      id: 'intro',
      kind: 'markdown',
      source: '# Hello\n notebook'
    })
    expect(notebook.cells[1]).toMatchObject({
      id: 'code',
      kind: 'code',
      executionCount: 7,
      language: 'python'
    })
    expect(notebook.cells[1]?.outputs[0]).toMatchObject({
      kind: 'stream',
      drawn: { text: 'hi\n', truncated: false }
    })
    expect(notebook.cells[1]?.outputs[1]).toMatchObject({
      kind: 'display',
      items: [{ mime: 'text/html' }, { mime: 'text/plain' }]
    })
  })

  it('rejects invalid notebook roots', () => {
    expect(() => parseIpynb('[]')).toThrow('Notebook root must be a JSON object')
    expect(() => parseIpynb('{}')).toThrow('Notebook is missing a cells array')
  })

  it('serializes cell source edits while preserving notebook metadata', () => {
    const content = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { custom: true },
      cells: [{ cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: [] }]
    })

    const updated = edited(content, (doc) =>
      updateIpynbCellSource(doc, 0, 'print("hi")\nprint("bye")')
    )
    expect(updated.metadata).toEqual({ custom: true })
    expect(updated.cells[0].source).toEqual(['print("hi")\n', 'print("bye")'])
  })

  it('serializes newline-heavy cell sources without regex match or split helpers', () => {
    const content = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: [] }]
    })
    const split = vi.spyOn(String.prototype, 'split')
    const match = vi.spyOn(String.prototype, 'match')
    const source = `${'print(1)\n'.repeat(5000)}last`

    const updated = edited(content, (doc) => updateIpynbCellSource(doc, 0, source))

    expect(updated.cells[0].source).toHaveLength(5001)
    expect(updated.cells[0].source[0]).toBe('print(1)\n')
    expect(updated.cells[0].source.at(-1)).toBe('last')
    expect(split).not.toHaveBeenCalled()
    expect(match).not.toHaveBeenCalled()
  })

  it('inserts, deletes, and changes cell kinds', () => {
    const content = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ cell_type: 'markdown', metadata: {}, source: ['# Title'] }]
    })

    const inserted = edited(content, (doc) => insertIpynbCell(doc, 1, 'code', 'python'))
    expect(inserted.cells).toHaveLength(2)
    expect(inserted.cells[1]).toMatchObject({
      cell_type: 'code',
      execution_count: null,
      outputs: [],
      metadata: { vscode: { languageId: 'python' } }
    })

    const changed = edited(JSON.stringify(inserted), (doc) =>
      updateIpynbCellKind(doc, 0, 'code', 'python')
    )
    expect(changed.cells[0]).toMatchObject({ cell_type: 'code', outputs: [] })

    const deleted = edited(JSON.stringify(changed), (doc) => deleteIpynbCell(doc, 1))
    expect(deleted.cells).toHaveLength(1)
  })

  it('moves cells up and down while preserving cell data', () => {
    const content = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        {
          id: 'a',
          cell_type: 'code',
          metadata: {},
          execution_count: 1,
          outputs: [],
          source: ['a']
        },
        { id: 'b', cell_type: 'markdown', metadata: { keep: true }, source: ['b'] },
        { id: 'c', cell_type: 'code', metadata: {}, execution_count: 2, outputs: [], source: ['c'] }
      ]
    })

    const movedDown = edited(content, (doc) => moveIpynbCell(doc, 0, 1))
    expect(movedDown.cells.map((cell: { id: string }) => cell.id)).toEqual(['b', 'a', 'c'])
    expect(movedDown.cells[0].metadata).toEqual({ keep: true })

    const movedUp = edited(JSON.stringify(movedDown), (doc) => moveIpynbCell(doc, 2, -1))
    expect(movedUp.cells.map((cell: { id: string }) => cell.id)).toEqual(['b', 'c', 'a'])

    const document = parseIpynbDocument(content)
    expect(moveIpynbCell(document, 0, -1)).toBe(document)
    expect(moveIpynbCell(document, 2, 1)).toBe(document)
  })

  it('writes a kernel run into the cell, storing stream text as lines without display ids', () => {
    const content = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        { id: 'a', cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: [] }
      ]
    })

    const updated = edited(content, (doc) =>
      updateIpynbCodeCell(doc, 'a', {
        outputs: () => [
          { output_type: 'stream', name: 'stdout', text: 'a\nb' },
          {
            output_type: 'execute_result',
            execution_count: 7,
            data: { 'text/plain': '42' },
            metadata: {},
            transient: { display_id: 'd' }
          }
        ],
        executionCount: 7
      })
    )
    expect(updated.cells[0].execution_count).toBe(7)
    expect(updated.cells[0].outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: ['a\n', 'b'] },
      {
        output_type: 'execute_result',
        execution_count: 7,
        data: { 'text/plain': '42' },
        metadata: {}
      }
    ])
  })

  it('serializes newline-heavy stream output without regex match or split helpers', () => {
    const document = parseIpynbDocument(
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
          {
            id: 'a',
            cell_type: 'code',
            metadata: {},
            execution_count: null,
            outputs: [],
            source: []
          }
        ]
      })
    )
    const run = updateIpynbCodeCell(document, 'a', {
      outputs: () => [
        { output_type: 'stream', name: 'stdout', text: `${'line\n'.repeat(5000)}tail` }
      ]
    })
    const split = vi.spyOn(String.prototype, 'split')
    const match = vi.spyOn(String.prototype, 'match')

    const updated = JSON.parse(serializeIpynbDocument(run))

    expect(updated.cells[0].outputs[0].text).toHaveLength(5001)
    expect(updated.cells[0].outputs[0].text.at(-1)).toBe('tail')
    expect(split).not.toHaveBeenCalled()
    expect(match).not.toHaveBeenCalled()
  })

  it('clears every code cell output and count, leaving other cells alone', () => {
    const content = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        { cell_type: 'markdown', metadata: {}, source: ['# hi'] },
        {
          cell_type: 'code',
          metadata: {},
          execution_count: 3,
          outputs: [{ output_type: 'stream', name: 'stdout', text: ['x'] }],
          source: []
        }
      ]
    })
    const cleared = edited(content, clearIpynbOutputs)
    expect(cleared.cells[0]).toEqual({ cell_type: 'markdown', metadata: {}, source: ['# hi'] })
    expect(cleared.cells[1]).toMatchObject({ execution_count: null, outputs: [] })
  })

  it('upgrades an nbformat 4.4 notebook to cell ids, keeping existing ones', () => {
    const content = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 4,
      metadata: {},
      cells: [
        { id: 'kept', cell_type: 'markdown', metadata: {}, source: [] },
        { cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: [] }
      ]
    })
    const upgraded = edited(content, withIpynbCellIds)
    expect(upgraded.nbformat_minor).toBe(5)
    expect(upgraded.cells[0].id).toBe('kept')
    expect(upgraded.cells[1].id).toMatch(/^[\w-]+$/)
    const document = parseIpynbDocument(JSON.stringify(upgraded))
    expect(withIpynbCellIds(document)).toBe(document)
  })
})
