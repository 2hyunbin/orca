import { createContext } from 'react'

/**
 * Drawers that open where a scrim of the same colour already dims the screen (the native overlay
 * route's, until the page under it paints): their backdrop starts at full strength while the sheet
 * still slides up, so the hand-off from that scrim never brightens the screen.
 */
export const DrawerBackdropAlreadyDimmedContext = createContext(false)
