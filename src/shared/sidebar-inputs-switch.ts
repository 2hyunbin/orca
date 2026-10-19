// Main produces the sidebar's inputs in every build; the window and the phone page read its feed.
// Every former switch point still branches on ORCA_SIDEBAR_INPUTS_IS_MAIN so the follow-up that
// deletes the switch-off paths can find them; until then each branch keeps its on side.

// Why `boolean`: a literal `true` would mark every switch-off branch as a type error before it is deleted.
export const ORCA_SIDEBAR_INPUTS_IS_MAIN: boolean = true
