// Pages saved into the app's Documents folder, which the Files app shows as On My iPhone › Thendral.
import UIKit

enum Library {
  static var root: URL {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
  }

  static func safe(_ s: String) -> String {
    let bad = CharacterSet(charactersIn: "<>:\"/\\|?*").union(.controlCharacters)
    let cleaned = s.components(separatedBy: bad).joined(separator: " ")
      .split(separator: " ").joined(separator: " ")
    return cleaned.isEmpty ? "Untitled" : String(cleaned.prefix(80))
  }

  private static func folder(_ book: String?) throws -> URL {
    let dir = root.appendingPathComponent(safe(book ?? "My pages"), isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  /// b: {book, base, json, text, audio (base64), audioExt, photo (base64)}
  static func savePage(_ b: [String: Any]) throws -> [String: Any] {
    let dir = try folder(b["book"] as? String)
    let base = safe(b["base"] as? String ?? "Page")
    if let a = b["audio"] as? String, let data = Data(base64Encoded: a) {
      try data.write(to: dir.appendingPathComponent(base + "." + (b["audioExt"] as? String ?? "m4a")))
    }
    if let p = b["photo"] as? String, let data = Data(base64Encoded: p) {
      try data.write(to: dir.appendingPathComponent(base + ".jpg"))
    }
    if let t = b["text"] as? String {
      try t.write(to: dir.appendingPathComponent(base + ".txt"), atomically: true, encoding: .utf8)
    }
    if let j = b["json"] as? String {
      try j.write(to: dir.appendingPathComponent(base + ".thendral.json"), atomically: true, encoding: .utf8)
    }
    return ["dir": dir.path, "base": base]
  }

  /// f: {book, name, text | data (base64)}
  static func saveFile(_ f: [String: Any]) throws -> [String: Any] {
    let dir = try folder(f["book"] as? String)
    let name = f["name"] as? String ?? "file"
    let ext = (name as NSString).pathExtension
    let file = dir.appendingPathComponent(safe((name as NSString).deletingPathExtension) + (ext.isEmpty ? "" : "." + ext))
    if let t = f["text"] as? String {
      try t.write(to: file, atomically: true, encoding: .utf8)
    } else if let d = f["data"] as? String, let data = Data(base64Encoded: d) {
      try data.write(to: file)
    }
    return ["file": file.path]
  }

  static func openInFiles(sub: String) {
    let dir = sub.isEmpty ? root : root.appendingPathComponent(safe(sub))
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    guard let url = URL(string: "shareddocuments://" + dir.path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)!) else { return }
    DispatchQueue.main.async { UIApplication.shared.open(url) }
  }
}
