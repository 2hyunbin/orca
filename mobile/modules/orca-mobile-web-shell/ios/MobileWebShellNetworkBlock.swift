import CryptoKit
import WebKit

private let networkBlockIdentifierPrefix = "dev.orca.mobile-web-shell.network-block-"

/// Blocks every http(s) and ws(s) load beneath CSP, at the network layer. A nil compile result is a
/// fence we could not install, which is terminal: nothing loads.
private let networkBlockRules = """
  [
    { "trigger": { "url-filter": "^https?://" }, "action": { "type": "block" } },
    { "trigger": { "url-filter": "^wss?://" }, "action": { "type": "block" } }
  ]
  """

/// Keyed by the rule source, so a stored list compiled from older rules is never looked up.
private let networkBlockIdentifier = networkBlockIdentifierPrefix + SHA256
  .hash(data: Data(networkBlockRules.utf8))
  .prefix(16)
  .map { String(format: "%02x", $0) }
  .joined()

/// One compiled fence per process, fetched at module creation so a page's first load never waits on
/// the store. A miss compiles and drops lists stored under older rules. Main thread only.
enum MobileWebShellNetworkBlock {
  private static var ruleList: WKContentRuleList?
  private static var waiting: [(WKContentRuleList?) -> Void] = []

  static func load(_ completion: @escaping (WKContentRuleList?) -> Void) {
    if let ruleList {
      completion(ruleList)
      return
    }
    waiting.append(completion)
    guard waiting.count == 1 else { return }
    // Optional-chaining past a missing store ran no completion handler at all, so the view sat at
    // `loading` for the rest of its life. No store is no fence, which is the same terminal answer.
    guard let store = WKContentRuleListStore.default() else {
      finish(nil)
      return
    }
    store.lookUpContentRuleList(forIdentifier: networkBlockIdentifier) { stored, _ in
      if let stored {
        DispatchQueue.main.async { finish(stored) }
        return
      }
      store.compileContentRuleList(
        forIdentifier: networkBlockIdentifier,
        encodedContentRuleList: networkBlockRules
      ) { compiled, _ in
        DispatchQueue.main.async { finish(compiled) }
        guard compiled != nil else { return }
        store.getAvailableContentRuleListIdentifiers { identifiers in
          for stale in identifiers ?? []
          where stale.hasPrefix(networkBlockIdentifierPrefix) && stale != networkBlockIdentifier {
            store.removeContentRuleList(forIdentifier: stale) { _ in }
          }
        }
      }
    }
  }

  private static func finish(_ compiled: WKContentRuleList?) {
    ruleList = compiled
    let completions = waiting
    waiting = []
    completions.forEach { $0(compiled) }
  }
}
