import { describe, expect, it } from 'vitest'
import { pluginSyntaxPackMetadataSchema } from '../../../../shared/plugins/plugin-syntax-pack'
import {
  PluginSyntaxSlotPool,
  matchingPluginSyntaxLanguages,
  resolvePluginSyntaxLanguage
} from './plugin-syntax-slot-pool'

function pack(publisher = 'community', revision = 'one') {
  return pluginSyntaxPackMetadataSchema.parse({
    pluginKey: `${publisher}.syntax-sample`,
    name: 'Sample syntax',
    revision,
    languages: [
      {
        id: 'sample',
        key: `syntax:${publisher}.syntax-sample/sample`,
        scopeName: 'source.sample',
        extensions: ['.sample', '.sample.md'],
        filenames: ['Samplefile']
      }
    ]
  })
}

describe('qualified syntax ownership and transient host slots', () => {
  it('keeps an explicit unavailable publisher from silently selecting a competing package', () => {
    const other = pluginSyntaxPackMetadataSchema.parse({
      pluginKey: 'another.pack',
      name: 'Another',
      revision: 'one',
      languages: [
        {
          id: 'sample',
          key: 'syntax:another.pack/sample',
          scopeName: 'source.sample',
          extensions: ['.sample']
        }
      ]
    })
    expect(resolvePluginSyntaxLanguage([other], '/file.sample', 'plaintext')).toBe(
      other.languages[0]!.key
    )
    expect(
      resolvePluginSyntaxLanguage(
        [other],
        '/file.sample',
        'plaintext',
        'syntax:community.syntax-pack/sample'
      )
    ).toBeNull()
    expect(
      resolvePluginSyntaxLanguage(
        [other],
        '/file.sample',
        'typescript',
        'syntax:community.syntax-pack/sample'
      )
    ).toBeNull()
    expect(
      resolvePluginSyntaxLanguage([other], '/file.sample', 'typescript', other.languages[0]!.key)
    ).toBe(other.languages[0]!.key)
  })

  it('matches portable basenames and compound extensions without interpreting author expressions', () => {
    const metadata = pack()
    for (const path of [
      '/remote/EXAMPLE.SAMPLE',
      'C:\\work\\SAMPLEFILE',
      '/folder/note.sample.md'
    ]) {
      expect(matchingPluginSyntaxLanguages([metadata], path)).toHaveLength(1)
    }
    expect(matchingPluginSyntaxLanguages([metadata], '/work/Samplefile/other.txt')).toEqual([])
  })

  it('preserves core ownership, declines conflicts and honors only an available qualified explicit choice', () => {
    const first = pack()
    const second = pack('another')
    expect(resolvePluginSyntaxLanguage([first], '/file.sample', 'plaintext')).toBe(
      first.languages[0]!.key
    )
    expect(resolvePluginSyntaxLanguage([first], '/file.sample.md', 'markdown')).toBeNull()
    expect(resolvePluginSyntaxLanguage([first, second], '/file.sample', 'plaintext')).toBeNull()
    expect(
      resolvePluginSyntaxLanguage(
        [first, second],
        '/file.sample',
        'plaintext',
        second.languages[0]!.key
      )
    ).toBe(second.languages[0]!.key)
    expect(
      resolvePluginSyntaxLanguage([first], '/file.sample', 'plaintext', second.languages[0]!.key)
    ).toBeNull()
  })

  it('allocates lazily and qualifies identically named languages from different publishers', () => {
    const pool = new PluginSyntaxSlotPool()
    const first = pack(),
      second = pack('another')
    pool.replace([first, second])
    expect(pool.byId('orca-plugin-syntax-slot-0')).toBeNull()
    const a = pool.claim(first.languages[0]!.key)!
    const b = pool.claim(second.languages[0]!.key)!
    expect(a.id).not.toBe(b.id)
    expect(pool.claim(a.key)).toBe(a)
    expect(pool.claim('syntax:absent.owner/sample')).toBeNull()
  })

  it('bounds slots and invalidates a prior owner before reusing its editor ID', () => {
    const pool = new PluginSyntaxSlotPool(1)
    const first = pack(),
      second = pack('another')
    pool.replace([first, second])
    const old = pool.claim(first.languages[0]!.key)!
    expect(pool.claim(second.languages[0]!.key)).toBeNull()
    expect(pool.replace([second])).toEqual([old])
    const replacement = pool.claim(second.languages[0]!.key)!
    expect(replacement.id).toBe(old.id)
    expect(pool.owns(old)).toBe(false)
    expect(pool.owns(replacement)).toBe(true)
  })

  it('withdraws changed revisions while retaining an unchanged package slot', () => {
    const pool = new PluginSyntaxSlotPool()
    const first = pack()
    pool.replace([first])
    const old = pool.claim(first.languages[0]!.key)!
    expect(pool.replace([pack()])).toEqual([])
    expect(pool.owns(old)).toBe(true)
    expect(pool.replace([pack('community', 'two')])).toEqual([old])
    expect(pool.owns(old)).toBe(false)
    expect(pool.claim(old.key)).not.toBe(old)
  })
})
