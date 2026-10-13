import { describe, expect, it } from 'vitest'
import {
  parsePluginGitTree,
  readPluginGitBatchBlobs
} from '../../shared/plugins/plugin-git-tree-format'
import {
  PLUGIN_TREE_MAX_BYTES,
  PLUGIN_TREE_MAX_ENTRIES
} from '../../shared/plugins/plugin-tree-limits'

const object = 'a'.repeat(40)
const record = (path: string, size = 3, mode = '100644', type = 'blob') =>
  `${mode} ${type} ${object} ${type === 'tree' ? '-' : size}\t${path}\0`
const parse = (text: string) => parsePluginGitTree(Buffer.from(text))

describe('portable raw Git tree boundaries', () => {
  it('counts directories and logical duplicate blob bytes before loading contents', () => {
    expect(parse(record('nested', 0, '040000', 'tree') + record('nested/file'))).toHaveLength(2)
    expect(() => parse(record('one', PLUGIN_TREE_MAX_BYTES) + record('two'))).toThrow('byte limit')
    expect(() =>
      parse(
        Array.from({ length: PLUGIN_TREE_MAX_ENTRIES + 1 }, (_, i) => record(`file-${i}`)).join('')
      )
    ).toThrow('entry limit')
  })

  it.each([
    '../outside',
    '/absolute',
    'dir\\file',
    'dir//file',
    'CON.json',
    'file:stream',
    'file.',
    'file ',
    '.git/config',
    '.GIT',
    'git~1',
    '.g\u200cit',
    'a'.repeat(1025),
    Array.from({ length: 65 }, () => 'a').join('/')
  ])('refuses unsafe Git paths before materialization: %s', (path) => {
    expect(() => parse(record(path))).toThrow('unsafe portable')
  })

  it('refuses case and Unicode aliases, absent parents, links and submodules', () => {
    expect(() => parse(record('File') + record('file'))).toThrow('colliding')
    expect(() => parse(record('caf\u00e9') + record('cafe\u0301'))).toThrow('colliding')
    expect(() => parse(record('dir/file'))).toThrow('missing directory')
    expect(() => parse(record('link', 3, '120000'))).toThrow('symlinks')
    expect(() => parse(record('module', 3, '160000', 'commit'))).toThrow('submodules')
    expect(() => parse(record('dir', 3, '040000'))).toThrow('mode, type or size')
  })

  it('refuses invalid UTF-8 and incomplete metadata', () => {
    expect(() => parsePluginGitTree(Buffer.from([0xff, 0]))).toThrow()
    expect(() => parse(record('file').slice(0, -1))).toThrow('truncated')
  })
})

describe('binary Git batch framing', () => {
  it('retains zero bytes/newlines and shares repeated object data', () => {
    const entries = parse(record('one') + record('two'))
    const bytes = Buffer.concat([
      Buffer.from(`${object} blob 3\n`),
      Buffer.from([0, 10, 255]),
      Buffer.from('\n')
    ])
    expect(readPluginGitBatchBlobs(bytes, entries).get(object)).toEqual(Buffer.from([0, 10, 255]))
    expect(readPluginGitBatchBlobs(bytes, entries).size).toBe(1)
  })

  it('rejects wrong identity/size, truncated blobs and trailing output', () => {
    const entries = parse(record('one'))
    for (const bytes of [
      Buffer.from(`${'b'.repeat(40)} blob 3\nabc\n`),
      Buffer.from(`${object} blob 4\nabc\n`),
      Buffer.from(`${object} blob 3\nab\n`),
      Buffer.from(`${object} blob 3\nabc\nextra`),
      Buffer.alloc(0)
    ]) {
      expect(() => readPluginGitBatchBlobs(bytes, entries)).toThrow()
    }
  })
})
