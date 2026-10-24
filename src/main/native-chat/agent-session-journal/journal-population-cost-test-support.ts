export type PopulationCost = {
  rawRowParses: number
  rawRowParseBytes: number
  terminalCursorProbes: number
  points: number
  settlementIteratorSteps: number
  settlementConstructorInputs: number
  populationCopiedInputs: number
  wrapperConstructors: number
  structuralRowSteps: number
  dependencySteps: number
  cleanupSteps: number
  legacyClassifications: number
  legacyDisplayEvaluations: number
  legacyDependentYields: number
  legacyDirtyMembers: number
  iteratorSteps: number
  constructorInputs: number
  constructors: number
  cowConstructors: number
  clears: number
  failedSql: number
  sqlExecStatements: number
  sourceEncodedBytes: number
  rangeRows: number
  sqlCalls: number
  sqlRows: number
  countCardinality: number
  changedRows: number
  secondaryWrites: number
  encodedBytes: number
  checkpointBytes: number
  populationDeletes: number
  countNamespaces: Record<string, number>
  wrapperKinds: Record<string, number>
  namespaces: Record<string, { points: number; iterated: number }>
}

export const emptyPopulationCost = (): PopulationCost => ({
  rawRowParses: 0,
  rawRowParseBytes: 0,
  terminalCursorProbes: 0,
  points: 0,
  settlementIteratorSteps: 0,
  settlementConstructorInputs: 0,
  populationCopiedInputs: 0,
  wrapperConstructors: 0,
  structuralRowSteps: 0,
  dependencySteps: 0,
  cleanupSteps: 0,
  legacyClassifications: 0,
  legacyDisplayEvaluations: 0,
  legacyDependentYields: 0,
  legacyDirtyMembers: 0,
  iteratorSteps: 0,
  constructorInputs: 0,
  constructors: 0,
  cowConstructors: 0,
  clears: 0,
  failedSql: 0,
  sqlExecStatements: 0,
  sourceEncodedBytes: 0,
  rangeRows: 0,
  sqlCalls: 0,
  sqlRows: 0,
  countCardinality: 0,
  changedRows: 0,
  secondaryWrites: 0,
  encodedBytes: 0,
  checkpointBytes: 0,
  populationDeletes: 0,
  countNamespaces: {},
  wrapperKinds: {},
  namespaces: {}
})

export function populationEncodedBytes(value: unknown): number {
  if (typeof value === 'string') {
    return Buffer.byteLength(value)
  }
  if (value instanceof Uint8Array) {
    return value.byteLength
  }
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + populationEncodedBytes(item), 0)
  }
  if (value && typeof value === 'object') {
    return Object.values(value).reduce<number>(
      (total, item) => total + populationEncodedBytes(item),
      0
    )
  }
  return 0
}
