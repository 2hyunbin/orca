import UIKit
import WebKit

/// The first page view in a process waits for WebKit to launch its helper processes. A blank view
/// loaded while Home is idle pays that instead, and is held until the first page has loaded so the
/// page starts against processes that are already up. Main thread only.
enum MobileWebShellWarmUp {
  private static var view: WKWebView?
  private static var started = false

  static func start() {
    // A launch into the background may never show a page, so it gets no web process.
    guard !started, UIApplication.shared.applicationState == .active else { return }
    started = true
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.loadHTMLString("", baseURL: nil)
    self.view = view
    // Bounds the process's life when no page is opened.
    DispatchQueue.main.asyncAfter(deadline: .now() + 60) { release() }
  }

  static func release() {
    view = nil
  }
}
