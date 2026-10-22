/** Whether main's catalog row carries every field an update set, as the host answered it. */
export function catalogRowShowsUpdate(row: object, expected: object, updates: object): boolean {
  return Object.keys(updates).every((key) => {
    const shown = Reflect.get(row, key)
    // Main withholds an uploaded icon's data URL (repoIcon null); its id arrives separately.
    if (key === 'repoIcon' && shown === null) {
      return true
    }
    return JSON.stringify(shown) === JSON.stringify(Reflect.get(expected, key))
  })
}
