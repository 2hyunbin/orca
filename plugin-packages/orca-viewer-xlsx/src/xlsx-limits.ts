export const XLSX_LIMITS = {
  inputBytes: 50 * 1024 * 1024,
  expandedBytes: 128 * 1024 * 1024,
  partBytes: 20 * 1024 * 1024,
  parts: 10_000,
  sheets: 100,
  cells: 500_000,
  sharedStrings: 500_000,
  retainedTextBytes: 32 * 1024 * 1024,
  textLength: 8192,
  rows: 1_000_000,
  columns: 16_384,
  nodes: 2_000_000,
  nesting: 64,
  parseMs: 10_000,
  readBytes: 192 * 1024,
  inflateInputBytes: 1024
} as const

export class XlsxFailure extends Error {
  constructor(readonly code: 'unsupported_format' | 'limit_exceeded' | 'parse_failed') {
    super(code)
  }
}

export class XlsxBudget {
  private readonly started = performance.now()
  private lastYield = this.started
  expandedBytes = 0
  nodes = 0
  cells = 0
  retainedTextBytes = 0

  check(): void {
    if (performance.now() - this.started >= XLSX_LIMITS.parseMs) {
      throw new XlsxFailure('limit_exceeded')
    }
  }

  async checkpoint(): Promise<void> {
    this.check()
    if (performance.now() - this.lastYield >= 32) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      this.lastYield = performance.now()
      this.check()
    }
  }

  text(value: string): string {
    if (value.length > XLSX_LIMITS.textLength) {
      throw new XlsxFailure('limit_exceeded')
    }
    return value
  }

  retain(value: string): string {
    this.text(value)
    this.retainedTextBytes += value.length * 2
    if (this.retainedTextBytes > XLSX_LIMITS.retainedTextBytes) {
      throw new XlsxFailure('limit_exceeded')
    }
    return value
  }
}
