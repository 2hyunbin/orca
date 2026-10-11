// Why: one skills CLI for every install rail and the CI round trip. 1.5.x cannot fetch a
// commit, and a bare `npx skills` can reuse a stale cached copy or another binary (#18687).
// Kept import-free so the plain-Node round-trip script can load it directly.
export const SKILLS_CLI_VERSION = '1.7.2'
