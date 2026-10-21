// Thendral for iPhone: the same Thendral page (app/ folder, bundled as "web") in a full-screen web view,
// with a native bridge for the Kokoro voice, Apple's text recognition and saving into Files.
import AVFoundation
import SwiftUI
import WebKit

@main
struct ThendralApp: App {
  init() {
    // keep reading when the screen locks, and show the lock-screen controls
    try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
    try? AVAudioSession.sharedInstance().setActive(true)
  }

  var body: some Scene {
    WindowGroup {
      WebAppView()
        .ignoresSafeArea()
        .background(Color(red: 0.957, green: 0.965, blue: 0.984))
    }
  }
}

struct WebAppView: UIViewRepresentable {
  func makeCoordinator() -> Bridge { Bridge() }

  func makeUIView(context: Context) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: "app")
    config.allowsInlineMediaPlayback = true
    config.mediaTypesRequiringUserActionForPlayback = []
    let controller = config.userContentController
    controller.add(context.coordinator, name: "thendral")
    controller.addUserScript(WKUserScript(source: Bridge.pageScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))

    let web = WKWebView(frame: .zero, configuration: config)
    web.scrollView.contentInsetAdjustmentBehavior = .never
    web.isOpaque = false
    web.backgroundColor = .clear
    if #available(iOS 16.4, *) { web.isInspectable = true }
    context.coordinator.webView = web
    web.load(URLRequest(url: URL(string: "app://local/index.html")!))
    return web
  }

  func updateUIView(_ uiView: WKWebView, context: Context) {}
}

/// Serves the bundled web folder at app://local/…
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
  private let root = Bundle.main.resourceURL!.appendingPathComponent("web")

  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    guard let url = task.request.url else { return }
    var path = url.path
    if path.isEmpty || path == "/" { path = "/index.html" }
    let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
    guard file.path.hasPrefix(root.standardizedFileURL.path), let data = try? Data(contentsOf: file) else {
      let res = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!
      task.didReceive(res)
      task.didFinish()
      return
    }
    let res = HTTPURLResponse(
      url: url, statusCode: 200, httpVersion: "HTTP/1.1",
      headerFields: ["Content-Type": Self.mime(file.pathExtension), "Content-Length": "\(data.count)", "Access-Control-Allow-Origin": "*"])!
    task.didReceive(res)
    task.didReceive(data)
    task.didFinish()
  }

  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

  static func mime(_ ext: String) -> String {
    switch ext.lowercased() {
    case "html": return "text/html; charset=utf-8"
    case "js", "mjs": return "text/javascript; charset=utf-8"
    case "css": return "text/css; charset=utf-8"
    case "json", "webmanifest": return "application/json"
    case "png": return "image/png"
    case "jpg", "jpeg": return "image/jpeg"
    case "svg": return "image/svg+xml"
    case "mp3": return "audio/mpeg"
    case "m4a": return "audio/mp4"
    case "wasm": return "application/wasm"
    default: return "application/octet-stream"
    }
  }
}
