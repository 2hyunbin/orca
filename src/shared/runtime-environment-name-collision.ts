/**
 * The saved server another server's name would be confused with.
 * Why: `--environment <name>` resolves names case- and whitespace-insensitively and refuses a
 * name two servers share, so saving `Build` beside `build` makes both unreachable by name.
 */
export function findCollidingEnvironmentName<T extends { name: string }>(
  environments: readonly T[],
  name: string
): T | undefined {
  const key = name.trim().toLowerCase()
  return environments.find((entry) => entry.name.trim().toLowerCase() === key)
}
