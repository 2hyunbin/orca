import {
  openCloudDatabase,
  openInMemoryCloudDatabase,
  type CloudDatabase,
  type OpenCloudDatabaseInput
} from '@orca-cloud/cloud-database'

const CONNECTOR_SCHEMA_STATEMENTS: string[] = []

export async function openConnectorDatabase(
  input: Omit<OpenCloudDatabaseInput, 'service' | 'schemaStatements'>
): Promise<CloudDatabase> {
  return await openCloudDatabase({
    ...input,
    service: 'connector',
    schemaStatements: CONNECTOR_SCHEMA_STATEMENTS
  })
}

export async function openInMemoryConnectorDatabase(): Promise<CloudDatabase> {
  return await openInMemoryCloudDatabase(CONNECTOR_SCHEMA_STATEMENTS)
}
