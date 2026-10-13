import type { XlsxNumberFormat } from './xlsx-styles'
import { XlsxFailure } from './xlsx-limits'

type DateFormat = 'date' | 'time' | 'datetime' | 'elapsed'

function dateFormat(format: XlsxNumberFormat): DateFormat | undefined {
  if (format.id === 46) {
    return 'elapsed'
  }
  if ([18, 19, 20, 21, 45, 47].includes(format.id)) {
    return 'time'
  }
  if (format.id === 22) {
    return 'datetime'
  }
  if (
    [14, 15, 16, 17].includes(format.id) ||
    (format.id >= 27 && format.id <= 36) ||
    (format.id >= 50 && format.id <= 58)
  ) {
    return 'date'
  }
  if (!format.code || format.code.includes(';')) {
    return undefined
  }
  const tokens = format.code.toLowerCase().replace(/"[^"]*"|\\.|_.|\*./g, '')
  if (/\[h+\]/.test(tokens)) {
    return 'elapsed'
  }
  const plain = tokens.replace(/\[[^\]]*\]/g, '')
  const date = /[yd]/.test(plain)
  const time = /[hs]|am\/pm|a\/p/.test(plain)
  return date ? (time ? 'datetime' : 'date') : time ? 'time' : undefined
}

function serialDate(serial: number, date1904: boolean, format: DateFormat): string {
  const lastDay = date1904 ? 2_957_003 : 2_958_465
  if (serial < 0 || Math.floor(serial) > lastDay) {
    return String(serial)
  }
  const roundedSeconds = Math.round(serial * 86400)
  const totalSeconds =
    format === 'datetime' ? Math.min(roundedSeconds, lastDay * 86400 + 86399) : roundedSeconds
  const seconds = totalSeconds % 86400
  const hour = Math.floor(seconds / 3600)
  const minute = Math.floor(seconds / 60) % 60
  const second = seconds % 60
  const clock = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`
  if (format === 'elapsed') {
    return `${Math.floor(totalSeconds / 3600)}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`
  }
  if (format === 'time') {
    return clock
  }
  const day = format === 'date' ? Math.floor(serial) : Math.floor(totalSeconds / 86400)
  const date =
    !date1904 && day === 60
      ? '1900-02-29'
      : new Date(
          Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 31) +
            (day - (!date1904 && day > 60 ? 1 : 0)) * 86400000
        )
          .toISOString()
          .slice(0, 10)
  return format === 'datetime' ? `${date} ${clock}` : date
}

export function displayXlsxNumber(
  raw: string,
  format: XlsxNumberFormat,
  date1904: boolean
): string {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(raw)) {
    throw new XlsxFailure('parse_failed')
  }
  const number = Number(raw)
  if (!Number.isFinite(number)) {
    throw new XlsxFailure('parse_failed')
  }
  const date = dateFormat(format)
  if (date) {
    return serialDate(number, date1904, date)
  }
  if (format.id === 9 || format.id === 10) {
    const percent = number * 100
    return Number.isFinite(percent) ? `${percent.toFixed(format.id === 9 ? 0 : 2)}%` : raw
  }
  if (format.id === 1 || format.id === 2) {
    return number.toFixed(format.id === 1 ? 0 : 2)
  }
  if (format.id === 3 || format.id === 4) {
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: format.id === 3 ? 0 : 2,
      maximumFractionDigits: format.id === 3 ? 0 : 2
    }).format(number)
  }
  if (format.id === 11 || format.id === 48) {
    return number.toExponential(format.id === 11 ? 2 : 1).toUpperCase()
  }
  return raw
}
