/** Plugin engines describe Orca's app API, separately from orcad's artifact identity. */
export function orcadPluginHostVersion(): string {
  return process.env.ORCA_PLUGIN_HOST_VERSION ?? '0.0.0-orcad'
}
