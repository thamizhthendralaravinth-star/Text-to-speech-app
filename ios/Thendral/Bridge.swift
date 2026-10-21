// The page calls window.thendralNative.*; this answers those calls on the iPhone.
import UIKit
import WebKit

final class Bridge: NSObject, WKScriptMessageHandler {
  weak var webView: WKWebView?
  private let work = DispatchQueue(label: "thendral.work", qos: .userInitiated)

  /// Injected before the page loads: the same window.thendralNative shape the Windows app provides.
  static let pageScript = """
  (() => {
    let n = 0;
    const pending = {};
    const progress = {};
    const call = (op, payload) => new Promise((resolve, reject) => {
      const id = ++n;
      pending[id] = { resolve, reject };
      window.webkit.messageHandlers.thendral.postMessage({ id, op, payload: payload || {} });
    });
    window.__thendralResolve = (id, ok, data) => {
      const p = pending[id];
      delete pending[id];
      if (p) ok ? p.resolve(data) : p.reject(new Error(data));
    };
    window.__thendralProgress = (jobId, done, total) => {
      const f = progress[jobId];
      if (f) f({ id: jobId, type: 'progress', done, total });
    };
    const toB64 = (u8) => {
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      return btoa(s);
    };
    const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
    window.thendralNative = {
      platform: 'ios',
      info: () => call('info'),
      makeAudio: async (job, onProgress) => {
        progress[job.id] = onProgress;
        try {
          const r = await call('make', job);
          return { audio: fromB64(r.audio), type: r.type, ext: r.ext, timings: r.timings, duration: r.duration };
        } finally { delete progress[job.id]; }
      },
      savePage: (b) => call('save', {
        book: b.book, base: b.base, json: b.json, text: b.text || null,
        audio: b.mp3 ? toB64(b.mp3) : null, audioExt: b.audioExt || 'mp3',
        photo: b.photo ? toB64(b.photo) : null,
      }),
      saveFile: (f) => call('saveFile', { book: f.book, name: f.name, text: f.text != null ? f.text : null, data: f.data ? toB64(f.data) : null }),
      chooseFolder: () => call('info'),
      openFolder: (sub) => call('openFolder', { sub: sub || '' }),
      recognize: async (blob) => call('ocr', { image: toB64(new Uint8Array(await blob.arrayBuffer())) }),
    };
  })();
  """

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any], let id = body["id"] as? Int, let op = body["op"] as? String else { return }
    let payload = body["payload"] as? [String: Any] ?? [:]
    work.async {
      do {
        let result = try self.handle(op: op, payload: payload)
        self.reply(id: id, ok: true, value: result)
      } catch {
        self.reply(id: id, ok: false, value: error.localizedDescription)
      }
    }
  }

  private func handle(op: String, payload: [String: Any]) throws -> Any {
    switch op {
    case "info":
      return ["folder": "Files › On My iPhone › Thendral", "voiceReady": Voice.shared.isAvailable]
    case "make":
      return try Voice.shared.makePage(job: payload) { [weak self] jobId, done, total in
        self?.js("window.__thendralProgress(\(Self.quote(jobId)), \(done), \(total))")
      }
    case "save":
      return try Library.savePage(payload)
    case "saveFile":
      return try Library.saveFile(payload)
    case "openFolder":
      Library.openInFiles(sub: payload["sub"] as? String ?? "")
      return true
    case "ocr":
      guard let b64 = payload["image"] as? String, let data = Data(base64Encoded: b64) else { throw BridgeError("No image received.") }
      return try TextReader.read(imageData: data)
    default:
      throw BridgeError("Unknown request \(op)")
    }
  }

  private func reply(id: Int, ok: Bool, value: Any) {
    let json: String
    if let data = try? JSONSerialization.data(withJSONObject: ["v": value]), let s = String(data: data, encoding: .utf8) {
      json = s
    } else {
      json = "{\"v\":null}"
    }
    js("window.__thendralResolve(\(id), \(ok ? "true" : "false"), (\(json)).v)")
  }

  private func js(_ source: String) {
    DispatchQueue.main.async { self.webView?.evaluateJavaScript(source, completionHandler: nil) }
  }

  static func quote(_ s: String) -> String {
    let data = try? JSONSerialization.data(withJSONObject: [s])
    let arr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
    return String(arr.dropFirst().dropLast())
  }
}

struct BridgeError: LocalizedError {
  let message: String
  init(_ m: String) { message = m }
  var errorDescription: String? { message }
}
