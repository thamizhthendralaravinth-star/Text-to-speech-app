// Apple's on-device text recognition (Vision), returned in the same block/line/word shape the page
// already understands from its own reader, so paragraph matching and highlighting work unchanged.
import UIKit
import Vision

enum TextReader {
  static func read(imageData: Data) throws -> [String: Any] {
    guard let image = UIImage(data: imageData), let cg = image.cgImage else { throw BridgeError("The photo could not be opened.") }
    let orientation = CGImagePropertyOrientation(image.imageOrientation)
    let rotated = [.left, .right, .leftMirrored, .rightMirrored].contains(orientation)
    let width = Double(rotated ? cg.height : cg.width)
    let height = Double(rotated ? cg.width : cg.height)

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["en-GB", "en-US"]
    try VNImageRequestHandler(cgImage: cg, orientation: orientation, options: [:]).perform([request])

    // Vision uses 0…1 coordinates with the origin at the bottom left; the page wants pixels from the top left.
    func box(_ r: CGRect) -> [String: Double] {
      ["x0": Double(r.minX) * width, "y0": (1 - Double(r.maxY)) * height, "x1": Double(r.maxX) * width, "y1": (1 - Double(r.minY)) * height]
    }
    var lines: [[String: Any]] = []
    var total = 0.0
    for obs in request.results ?? [] {
      guard let cand = obs.topCandidates(1).first else { continue }
      let text = cand.string
      let conf = 50 + 50 * Double(cand.confidence)   // Vision is coarse (0.3/0.5/1.0); keep good words above the junk filter
      total += conf
      var words: [[String: Any]] = []
      var searchStart = text.startIndex
      for part in text.split(separator: " ", omittingEmptySubsequences: true) {
        guard let range = text.range(of: String(part), range: searchStart..<text.endIndex) else { continue }
        searchStart = range.upperBound
        let r = (try? cand.boundingBox(for: range))?.boundingBox ?? obs.boundingBox
        words.append(["text": String(part), "confidence": conf, "bbox": box(r)])
      }
      let bl = obs.bottomLeft, br = obs.bottomRight
      lines.append([
        "text": text,
        "bbox": box(obs.boundingBox),
        "words": words,
        "baseline": ["x0": Double(bl.x) * width, "y0": (1 - Double(bl.y)) * height, "x1": Double(br.x) * width, "y1": (1 - Double(br.y)) * height],
      ])
    }
    let count = Double(max(1, lines.count))
    return [
      "width": width,
      "height": height,
      "confidence": total / count,
      "blocks": [["paragraphs": [["lines": lines]]]],
    ]
  }
}

extension CGImagePropertyOrientation {
  init(_ o: UIImage.Orientation) {
    switch o {
    case .up: self = .up
    case .down: self = .down
    case .left: self = .left
    case .right: self = .right
    case .upMirrored: self = .upMirrored
    case .downMirrored: self = .downMirrored
    case .leftMirrored: self = .leftMirrored
    case .rightMirrored: self = .rightMirrored
    @unknown default: self = .up
    }
  }
}
