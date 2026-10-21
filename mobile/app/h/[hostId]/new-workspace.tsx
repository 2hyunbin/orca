import { NewWorkspacePageScreen } from '../../../src/new-workspace/NewWorkspacePageScreen'

/**
 * The page's Create Workspace route, which Home's `/new-workspace` overlay opens in its shell. One
 * file for both platforms: the screen is plain React Native, so no shell-mounting native sibling.
 */
export default function NewWorkspaceRoute() {
  return <NewWorkspacePageScreen />
}
