/**
 * react-native-web dismisses `on-drag` on every scroll event, and narrowing a filtered list clamps
 * its offset, which fires one, so each search keystroke would close the keyboard.
 */
export const SCROLL_KEYBOARD_DISMISS_MODE = 'none' as const
