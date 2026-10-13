import { parser, type QualifiedTag } from 'sax'
import { XLSX_LIMITS, XlsxFailure } from './xlsx-limits'
import type { XlsxZipArchive } from './xlsx-zip-archive'

export const XLSX_MAIN_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://purl.oclc.org/ooxml/spreadsheetml/main'
])
export const XLSX_RELATIONSHIP_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships'
])

export type XlsxXmlVisitor = {
  start?(tag: QualifiedTag, parents: readonly QualifiedTag[]): void
  text?(text: string, parents: readonly QualifiedTag[]): void
  end?(tag: QualifiedTag, parents: readonly QualifiedTag[]): void
}

export function xlsxAttribute(
  tag: QualifiedTag,
  local: string,
  namespace = ''
): string | undefined {
  return Object.values(tag.attributes).find(
    (attribute) => attribute.local === local && attribute.uri === namespace
  )?.value
}

export async function readXlsxXml(
  archive: XlsxZipArchive,
  name: string,
  rootName: string,
  namespaces: ReadonlySet<string>,
  visitor: XlsxXmlVisitor
): Promise<void> {
  const options = { xmlns: true, strictEntities: true }
  const xml = parser(true, options)
  const parents: QualifiedTag[] = []
  let rootSeen = false
  let decoder: TextDecoder | undefined
  let initial = new Uint8Array(0)
  xml.onerror = () => {
    throw new XlsxFailure('parse_failed')
  }
  xml.ondoctype = () => {
    throw new XlsxFailure('unsupported_format')
  }
  xml.onopentag = (tag) => {
    archive.budget.check()
    if (!('uri' in tag) || !('local' in tag)) {
      throw new XlsxFailure('parse_failed')
    }
    if (parents.length === 0) {
      if (rootSeen) {
        throw new XlsxFailure('parse_failed')
      }
      if (tag.local !== rootName || !namespaces.has(tag.uri)) {
        throw new XlsxFailure('unsupported_format')
      }
      rootSeen = true
    }
    if (
      ++archive.budget.nodes > XLSX_LIMITS.nodes ||
      parents.length >= XLSX_LIMITS.nesting ||
      Object.keys(tag.attributes).length > 64
    ) {
      throw new XlsxFailure('limit_exceeded')
    }
    for (const attribute of Object.values(tag.attributes)) {
      archive.budget.text(attribute.value)
    }
    visitor.start?.(tag, parents)
    parents.push(tag)
  }
  const text = (value: string): void => {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index)
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
        throw new XlsxFailure('parse_failed')
      }
    }
    visitor.text?.(value, parents)
  }
  xml.ontext = text
  xml.oncdata = text
  xml.onclosetag = () => {
    const tag = parents.pop()
    if (!tag) {
      throw new XlsxFailure('parse_failed')
    }
    visitor.end?.(tag, parents)
  }
  await archive.readPart(name, (bytes, final) => {
    if (!decoder) {
      const combined = new Uint8Array(initial.length + bytes.length)
      combined.set(initial)
      combined.set(bytes, initial.length)
      if (combined.length < 4 && !final) {
        initial = combined
        return
      }
      const encoding =
        (combined[0] === 0xff && combined[1] === 0xfe) ||
        (combined[0] === 0x3c && combined[1] === 0)
          ? 'utf-16le'
          : (combined[0] === 0xfe && combined[1] === 0xff) ||
              (combined[0] === 0 && combined[1] === 0x3c)
            ? 'utf-16be'
            : 'utf-8'
      decoder = new TextDecoder(encoding, { fatal: true })
      bytes = combined
      initial = new Uint8Array(0)
    }
    const decoded = decoder.decode(bytes, { stream: !final })
    for (let offset = 0; offset < decoded.length; offset += 16 * 1024) {
      archive.budget.check()
      xml.write(decoded.slice(offset, offset + 16 * 1024))
    }
    if (final) {
      xml.close()
    }
  })
  if (!rootSeen || parents.length) {
    throw new XlsxFailure('parse_failed')
  }
}
