// The Linear edge's tables, applied with the connector schema; same column rules as there.
const LINEAR_SCHEMA = `
CREATE TABLE IF NOT EXISTS connector_linear_installs (
  organization_id TEXT PRIMARY KEY,
  app_user_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  paused INTEGER NOT NULL,
  installed_at BIGINT NOT NULL
);
`

export function linearSchemaStatements(): string[] {
  return LINEAR_SCHEMA.split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}
