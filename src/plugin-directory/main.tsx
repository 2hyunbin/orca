import { createRoot } from 'react-dom/client'
import { PluginDirectory } from './PluginDirectory'
import { applyDirectoryTheme, readDirectoryTheme } from './directory-theme'
import './plugin-directory.css'

const theme = readDirectoryTheme()
applyDirectoryTheme(theme)
const root = document.getElementById('root')
if (!root) {
  throw new Error('Plugin directory mount is missing')
}
createRoot(root).render(<PluginDirectory initialTheme={theme} />)
