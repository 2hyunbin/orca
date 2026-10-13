import type { QualifiedTag } from 'sax'
import { XLSX_LIMITS, XlsxFailure } from './xlsx-limits'
import { hasXlsxPathControl } from './xlsx-path-characters'
import {
  readXlsxXml,
  xlsxAttribute,
  XLSX_MAIN_NAMESPACES,
  XLSX_RELATIONSHIP_NAMESPACES
} from './xlsx-xml'
import type { XlsxZipArchive } from './xlsx-zip-archive'

const PACKAGE_RELATIONSHIPS = new Set([
  'http://schemas.openxmlformats.org/package/2006/relationships'
])
const CONTENT_TYPES = new Set(['http://schemas.openxmlformats.org/package/2006/content-types'])
const WORKBOOK_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'

type Relationship = { type: string; target: string; external: boolean }
export type XlsxSheetPart = { id: string; label: string; part: string }
export type XlsxWorkbookGraph = {
  sheets: XlsxSheetPart[]
  date1904: boolean
  strings?: string
  styles?: string
}

export function isXlsxTag(tag: QualifiedTag, local: string): boolean {
  return tag.local === local && XLSX_MAIN_NAMESPACES.has(tag.uri)
}

export function resolveXlsxPart(source: string, target: string): string {
  if (
    !target ||
    target.length > 1024 ||
    /[\\:#?]/.test(target) ||
    hasXlsxPathControl(target, true)
  ) {
    throw new XlsxFailure('unsupported_format')
  }
  const parts = target.startsWith('/') ? [] : source.split('/').slice(0, -1)
  for (const encoded of target.replace(/^\//, '').split('/')) {
    let segment: string
    try {
      segment = decodeURIComponent(encoded)
    } catch {
      throw new XlsxFailure('parse_failed')
    }
    if (!segment || /[\\/:#?]/.test(segment) || hasXlsxPathControl(segment)) {
      throw new XlsxFailure('unsupported_format')
    }
    if (segment === '..') {
      if (!parts.pop()) {
        throw new XlsxFailure('unsupported_format')
      }
    } else if (segment !== '.') {
      parts.push(segment)
    }
  }
  if (parts.length === 0) {
    throw new XlsxFailure('parse_failed')
  }
  return parts.join('/')
}

function relationshipKind(type: string, kind: string): boolean {
  return [...XLSX_RELATIONSHIP_NAMESPACES].some((namespace) => type === `${namespace}/${kind}`)
}

async function readRelationships(
  archive: XlsxZipArchive,
  source: string
): Promise<Map<string, Relationship>> {
  const segments = source.split('/')
  const filename = segments.pop() ?? ''
  const name = source ? [...segments, '_rels', `${filename}.rels`].join('/') : '_rels/.rels'
  const relationships = new Map<string, Relationship>()
  await readXlsxXml(archive, name, 'Relationships', PACKAGE_RELATIONSHIPS, {
    start(tag, parents) {
      if (parents.length !== 1 || tag.uri !== parents[0].uri || tag.local !== 'Relationship') {
        return
      }
      const id = xlsxAttribute(tag, 'Id')
      const type = xlsxAttribute(tag, 'Type')
      const target = xlsxAttribute(tag, 'Target')
      const mode = xlsxAttribute(tag, 'TargetMode')
      if (
        !id ||
        id.length > 128 ||
        !type ||
        !target ||
        relationships.has(id) ||
        (mode !== undefined && mode !== 'Internal' && mode !== 'External')
      ) {
        throw new XlsxFailure('parse_failed')
      }
      if (
        relationshipKind(type, 'externalLink') ||
        relationshipKind(type, 'connections') ||
        /\/(?:vbaProject|vbaData)$/.test(type)
      ) {
        throw new XlsxFailure('unsupported_format')
      }
      const external = mode === 'External'
      relationships.set(id, {
        type,
        target: external ? target : resolveXlsxPart(source, target),
        external
      })
      if (relationships.size > XLSX_LIMITS.parts) {
        throw new XlsxFailure('limit_exceeded')
      }
    }
  })
  return relationships
}

async function readContentTypes(archive: XlsxZipArchive): Promise<Map<string, string>> {
  const types = new Map<string, string>()
  await readXlsxXml(archive, '[Content_Types].xml', 'Types', CONTENT_TYPES, {
    start(tag, parents) {
      if (parents.length !== 1 || tag.uri !== parents[0].uri) {
        return
      }
      const type = xlsxAttribute(tag, 'ContentType')
      if (!type || /macroEnabled|vbaProject|externalLink|connections/i.test(type)) {
        throw new XlsxFailure('unsupported_format')
      }
      if (tag.local === 'Override') {
        const name = xlsxAttribute(tag, 'PartName')
        if (!name?.startsWith('/')) {
          throw new XlsxFailure('parse_failed')
        }
        const part = resolveXlsxPart('', name)
        if (types.has(part)) {
          throw new XlsxFailure('parse_failed')
        }
        types.set(part, type)
      } else if (tag.local !== 'Default') {
        throw new XlsxFailure('parse_failed')
      }
      if (types.size > XLSX_LIMITS.parts) {
        throw new XlsxFailure('limit_exceeded')
      }
    }
  })
  return types
}

function uniquePart(
  relationships: Map<string, Relationship>,
  kind: string,
  required = false
): string | undefined {
  const matches = [...relationships.values()].filter((entry) => relationshipKind(entry.type, kind))
  if (
    matches.length > 1 ||
    (required && matches.length !== 1) ||
    matches.some((entry) => entry.external)
  ) {
    throw new XlsxFailure('unsupported_format')
  }
  return matches[0]?.target
}

export async function readXlsxWorkbookGraph(archive: XlsxZipArchive): Promise<XlsxWorkbookGraph> {
  const types = await readContentTypes(archive)
  const roots = await readRelationships(archive, '')
  const workbook = uniquePart(roots, 'officeDocument', true)
  if (!workbook || types.get(workbook) !== WORKBOOK_TYPE) {
    throw new XlsxFailure('unsupported_format')
  }
  const relationships = await readRelationships(archive, workbook)
  const sheets: XlsxSheetPart[] = []
  const ids = new Set<string>()
  const names = new Set<string>()
  const parts = new Set<string>()
  let date1904 = false
  let propertiesSeen = false
  await readXlsxXml(archive, workbook, 'workbook', XLSX_MAIN_NAMESPACES, {
    start(tag, parents) {
      if (isXlsxTag(tag, 'externalReferences') || isXlsxTag(tag, 'connections')) {
        throw new XlsxFailure('unsupported_format')
      }
      if (parents.length === 1 && isXlsxTag(tag, 'workbookPr')) {
        const value = xlsxAttribute(tag, 'date1904')
        if (
          propertiesSeen ||
          (value !== undefined && !['0', '1', 'true', 'false'].includes(value))
        ) {
          throw new XlsxFailure('parse_failed')
        }
        propertiesSeen = true
        date1904 = value === '1' || value === 'true'
      }
      if (parents.length !== 2 || !isXlsxTag(parents[1], 'sheets') || !isXlsxTag(tag, 'sheet')) {
        return
      }
      const id = xlsxAttribute(tag, 'sheetId')
      const label = xlsxAttribute(tag, 'name')
      const relationId = [...XLSX_RELATIONSHIP_NAMESPACES]
        .map((namespace) => xlsxAttribute(tag, 'id', namespace))
        .find((value) => value !== undefined)
      const relation = relationId ? relationships.get(relationId) : undefined
      if (
        !id ||
        !/^[1-9]\d{0,9}$/.test(id) ||
        !label ||
        label.length > 256 ||
        !relation ||
        relation.external ||
        !relationshipKind(relation.type, 'worksheet') ||
        ids.has(id) ||
        names.has(label.toLowerCase()) ||
        parts.has(relation.target)
      ) {
        throw new XlsxFailure('unsupported_format')
      }
      ids.add(id)
      names.add(label.toLowerCase())
      parts.add(relation.target)
      sheets.push({ id, label: archive.budget.retain(label), part: relation.target })
      if (sheets.length > XLSX_LIMITS.sheets) {
        throw new XlsxFailure('limit_exceeded')
      }
    }
  })
  if (sheets.length === 0) {
    throw new XlsxFailure('parse_failed')
  }
  return {
    sheets,
    date1904,
    strings: uniquePart(relationships, 'sharedStrings'),
    styles: uniquePart(relationships, 'styles')
  }
}
