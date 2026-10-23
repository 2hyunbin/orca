import Foundation

/// What the slots need from a booted page: whether it can still be shown, and how it goes away.
protocol MobileWebShellSparePage: AnyObject {
  var isUsable: Bool { get }
  func destroy()
}

struct MobileWebShellSpareEntry<Page: MobileWebShellSparePage> {
  let hostKey: String
  let directory: String
  let sessionId: String
  let page: Page
}

/// Who holds the spare: at most one parked app-wide, any number claimed by views about to adopt
/// them. The same rules as the Kotlin copy, and pure, so `swiftc` can check them without a device.
///
/// A session id is loaded by one WebView, ever. `park` refuses an id it has seen, `take` moves the
/// spare out of the parked slot before the caller learns its id, and an issued id whose page is gone
/// stays in `wasIssued`, so the view that names it can refuse to build a second page under it.
final class MobileWebShellSpareSlots<Page: MobileWebShellSparePage> {
  private var parked: MobileWebShellSpareEntry<Page>?
  private var claimed: [String: MobileWebShellSpareEntry<Page>] = [:]
  private var issued: Set<String> = []

  /// False when a live spare for this host and directory is already parked.
  func wants(hostKey: String, directory: String) -> Bool {
    guard let current = parked else { return true }
    return current.hostKey != hostKey || current.directory != directory || !current.page.isUsable
  }

  /// Replaces whatever is parked with a page booted for `sessionId`, built by `boot` only once the
  /// id is known to be fresh. False, and nothing built, for an id seen before.
  @discardableResult
  func park(hostKey: String, directory: String, sessionId: String, boot: () -> Page) -> Bool {
    discardParked()
    guard issued.insert(sessionId).inserted else { return false }
    parked = MobileWebShellSpareEntry(
      hostKey: hostKey,
      directory: directory,
      sessionId: sessionId,
      page: boot()
    )
    return true
  }

  /// The parked spare when it was booted for this host from `directory` and is still alive.
  func take(hostKey: String, directory: String) -> MobileWebShellSpareEntry<Page>? {
    guard let spare = parked, spare.hostKey == hostKey, spare.directory == directory,
      spare.page.isUsable
    else { return nil }
    parked = nil
    claimed[spare.sessionId] = spare
    return spare
  }

  func adopt(sessionId: String) -> MobileWebShellSpareEntry<Page>? {
    claimed.removeValue(forKey: sessionId)
  }

  /// A claimed spare no view adopted in time.
  func expire(sessionId: String) {
    claimed.removeValue(forKey: sessionId)?.page.destroy()
  }

  func wasIssued(sessionId: String) -> Bool {
    issued.contains(sessionId)
  }

  /// Nil for every host. Claimed spares are left to the view about to adopt them.
  func discard(hostKey: String?) {
    if hostKey == nil || parked?.hostKey == hostKey {
      discardParked()
    }
  }

  /// Memory pressure, the app leaving the foreground, or the module going away.
  func discardAll() {
    discardParked()
    claimed.values.forEach { $0.page.destroy() }
    claimed.removeAll()
  }

  private func discardParked() {
    parked?.page.destroy()
    parked = nil
  }
}
