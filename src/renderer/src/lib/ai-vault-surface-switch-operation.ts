export type AiVaultSurfaceSwitchOperation = {
  signal: AbortSignal
  isSourceOpen: () => boolean
  onDispatch?: () => void
}
