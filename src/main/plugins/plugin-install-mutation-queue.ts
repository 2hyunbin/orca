const pluginMutationChains = new Map<string, Promise<void>>()

export async function serializePluginMutation<T>(
  pluginsDir: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = pluginMutationChains.get(pluginsDir) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(operation)
  const settled = run.then(
    () => undefined,
    () => undefined
  )
  pluginMutationChains.set(pluginsDir, settled)
  try {
    return await run
  } finally {
    if (pluginMutationChains.get(pluginsDir) === settled) {
      pluginMutationChains.delete(pluginsDir)
    }
  }
}
