import { createContext } from 'react'

/**
 * Offered to the first drawer that opens where a scrim of its colour already dims the screen (the
 * native overlay's, until the page under it paints): that drawer opens with its backdrop at full
 * and takes the offer, so the drawers it opens later fade their own backdrops in as usual.
 */
export const DimmedBackdropOfferContext = createContext<(() => void) | null>(null)
