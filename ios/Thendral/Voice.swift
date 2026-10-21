// Kokoro voice on the iPhone (sherpa-onnx), one AAC file per page with each sentence's start and end time.
import AVFoundation
import Foundation
import SherpaOnnx

final class Voice {
  static let shared = Voice()

  private var tts: SherpaOnnxOfflineTtsWrapper?
  private let dir = Bundle.main.resourceURL!.appendingPathComponent("kokoro")

  var isAvailable: Bool { FileManager.default.fileExists(atPath: dir.appendingPathComponent("model.int8.onnx").path) }

  private func engine() throws -> SherpaOnnxOfflineTtsWrapper {
    if let tts { return tts }
    guard isAvailable else { throw BridgeError("The voice files are missing from this install.") }
    let kokoro = sherpaOnnxOfflineTtsKokoroModelConfig(
      model: dir.appendingPathComponent("model.int8.onnx").path,
      voices: dir.appendingPathComponent("voices.bin").path,
      tokens: dir.appendingPathComponent("tokens.txt").path,
      dataDir: dir.appendingPathComponent("espeak-ng-data").path)
    let threads = max(1, min(4, ProcessInfo.processInfo.activeProcessorCount - 2))
    let model = sherpaOnnxOfflineTtsModelConfig(kokoro: kokoro, numThreads: threads, debug: 0)
    var config = sherpaOnnxOfflineTtsConfig(model: model, maxNumSentences: 1)
    let made = SherpaOnnxOfflineTtsWrapper(config: &config)
    guard made.tts != nil else { throw BridgeError("The voice could not start.") }
    tts = made
    return made
  }

  /// job: {id, units:[{text, speak, paraEnd}], sid, speed, pause, paraPause}
  func makePage(job: [String: Any], progress: (String, Int, Int) -> Void) throws -> [String: Any] {
    let id = job["id"] as? String ?? ""
    let units = job["units"] as? [[String: Any]] ?? []
    let sid = job["sid"] as? Int ?? 1
    let speed = Float(job["speed"] as? Double ?? 1.0)
    let pause = job["pause"] as? Double ?? 0.45
    let paraPause = job["paraPause"] as? Double ?? 0.9
    let tts = try engine()
    let rate = Double(tts.sampleRate)

    var samples: [Float] = []
    var timings: [Any] = []
    for (i, u) in units.enumerated() {
      let text = (u["text"] as? String ?? "").trimmingCharacters(in: .whitespaces)
      guard (u["speak"] as? Bool ?? true), !text.isEmpty else { timings.append(NSNull()); continue }
      let start = Double(samples.count) / rate
      let audio = tts.generate(text: text, sid: sid, speed: speed)
      samples.append(contentsOf: audio.samples)
      let end = Double(samples.count) / rate
      timings.append([round(start * 1000) / 1000, round(end * 1000) / 1000])
      let gap = (u["paraEnd"] as? Bool ?? false) ? paraPause : pause
      if gap > 0 && i < units.count - 1 { samples.append(contentsOf: [Float](repeating: 0, count: Int(rate * gap))) }
      progress(id, i + 1, units.count)
    }
    let data = try encodeAAC(samples: samples, sampleRate: rate)
    return ["audio": data.base64EncodedString(), "type": "audio/mp4", "ext": "m4a", "timings": timings, "duration": Double(samples.count) / rate]
  }

  private func encodeAAC(samples: [Float], sampleRate: Double) throws -> Data {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".m4a")
    defer { try? FileManager.default.removeItem(at: url) }
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVSampleRateKey: sampleRate,
      AVNumberOfChannelsKey: 1,
      AVEncoderBitRateKey: 64000,
    ]
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)!
    do {
      let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
      let chunk = 32768
      var offset = 0
      while offset < samples.count {
        let n = min(chunk, samples.count - offset)
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(n))!
        buffer.frameLength = AVAudioFrameCount(n)
        samples.withUnsafeBufferPointer { src in
          buffer.floatChannelData![0].update(from: src.baseAddress! + offset, count: n)
        }
        try file.write(from: buffer)
        offset += n
      }
    }   // the file closes here, before it is read back
    return try Data(contentsOf: url)
  }
}
