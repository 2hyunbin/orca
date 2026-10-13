export type DirectoryTheme = 'light' | 'dark'

export function readDirectoryTheme(): DirectoryTheme {
  try {
    const saved = localStorage.getItem('orca-plugin-directory:theme')
    if (saved === 'light' || saved === 'dark') {
      return saved
    }
  } catch {
    // The system preference remains available when storage is disabled.
  }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyDirectoryTheme(theme: DirectoryTheme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.documentElement.style.colorScheme = theme
}

export function saveDirectoryTheme(theme: DirectoryTheme): void {
  try {
    localStorage.setItem('orca-plugin-directory:theme', theme)
  } catch {
    // Theme switching must remain usable without browser storage.
  }
}
