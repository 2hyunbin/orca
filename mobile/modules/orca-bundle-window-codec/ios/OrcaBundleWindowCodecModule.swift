import ExpoModulesCore

// Synchronous on purpose: each call is a few ms per window, and only a sync call reads its
// Uint8Array argument without a thread hop.
public class OrcaBundleWindowCodecModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OrcaBundleWindowCodec")

    Function("gunzip") { (input: Data, outputLimit: Int) throws -> Data in
      try gunzipBundleWindow(input, outputLimit: outputLimit)
    }

    Function("decodeUtf8") { (input: Data) -> String? in
      decodeBundleWindowUtf8(input)
    }
  }
}
