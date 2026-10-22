package expo.modules.orcabundlewindowcodec

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Synchronous on purpose: each call is a few ms per window, and only a sync call reads its
// Uint8Array argument without a thread hop.
class OrcaBundleWindowCodecModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OrcaBundleWindowCodec")

    Function("gunzip") { input: ByteArray, outputLimit: Int ->
      gunzipBundleWindow(input, outputLimit)
    }

    Function("decodeUtf8") { input: ByteArray ->
      decodeBundleWindowUtf8(input)
    }
  }
}
