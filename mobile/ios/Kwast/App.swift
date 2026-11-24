import SwiftUI
import WebKit

@main
struct KwastApp: App {
    var body: some Scene {
        WindowGroup { Marketplace() }
    }
}

struct Marketplace: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        let browser = WKWebView()
        browser.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        if #available(iOS 16.4, *) { browser.isInspectable = true }
        #endif
        if let entry = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "dist") {
            browser.loadFileURL(entry, allowingReadAccessTo: entry.deletingLastPathComponent())
        }
        return browser
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
}
