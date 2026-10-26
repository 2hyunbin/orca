// Applied at startup for both dialects, so every column type reads the same in SQLite and PostgreSQL.
const CONNECTOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS connector_sign_in_requests (
  device_code_hash TEXT PRIMARY KEY,
  user_code_hash TEXT NOT NULL UNIQUE,
  host_public_key TEXT NOT NULL,
  host_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  runtime TEXT NOT NULL,
  orca_version TEXT NOT NULL,
  request_ip TEXT NOT NULL,
  request_location TEXT,
  status TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL,
  next_poll_at BIGINT NOT NULL,
  account_email TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS connector_sign_in_requests_status
  ON connector_sign_in_requests(status, expires_at);

CREATE TABLE IF NOT EXISTS connector_hosts (
  host_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  account_email TEXT NOT NULL,
  host_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  runtime TEXT NOT NULL,
  orca_version TEXT NOT NULL,
  linked_at BIGINT NOT NULL,
  revoked_at BIGINT
);
CREATE INDEX IF NOT EXISTS connector_hosts_account ON connector_hosts(account_id);

CREATE TABLE IF NOT EXISTS connector_challenges (
  challenge_id TEXT PRIMARY KEY,
  host_fingerprint TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  consumed_at BIGINT
);
CREATE INDEX IF NOT EXISTS connector_challenges_expires_at ON connector_challenges(expires_at);

CREATE TABLE IF NOT EXISTS connector_sessions (
  token_hash TEXT PRIMARY KEY,
  host_fingerprint TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS connector_sessions_host ON connector_sessions(host_fingerprint);
CREATE INDEX IF NOT EXISTS connector_sessions_expires_at ON connector_sessions(expires_at);
`

export function connectorSchemaStatements(): string[] {
  return CONNECTOR_SCHEMA.split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}
