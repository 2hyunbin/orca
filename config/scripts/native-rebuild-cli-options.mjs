/** `rebuild-native-deps.mjs [--force] [--platform <p>] [--arch <a>]`; throws on anything else. */
export function readNativeRebuildCliOptions(args) {
  const options = { force: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--force') {
      options.force = true
      continue
    }
    if (arg === '--platform') {
      options.platform = readRequiredArgValue(args, (index += 1), '--platform')
      continue
    }
    if (arg.startsWith('--platform=')) {
      options.platform = readInlineArgValue(arg, '--platform')
      continue
    }
    if (arg === '--arch') {
      options.arch = readRequiredArgValue(args, (index += 1), '--arch')
      continue
    }
    if (arg.startsWith('--arch=')) {
      options.arch = readInlineArgValue(arg, '--arch')
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

function readRequiredArgValue(args, index, flag) {
  const value = args[index]
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`)
  }
  return value
}

function readInlineArgValue(arg, flag) {
  const value = arg.slice(`${flag}=`.length)
  if (!value) {
    throw new Error(`Missing value for ${flag}`)
  }
  return value
}
