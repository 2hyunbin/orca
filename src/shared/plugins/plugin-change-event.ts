export type PluginChangeEvent = {
  environmentProviderId?: string
  /** True only when declarative contribution catalogs were reconciled. */
  contentPacksChanged: boolean
}
