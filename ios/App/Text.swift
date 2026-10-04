import Foundation

/// Pure helpers (no UIKit / audio), so tests/main.swift can compile and run them on the Mac.
enum Speech {
    static let minChunk = 30   // UTF-16 units; don't speak fragments shorter than this while streaming

    private static let boundary = try! NSRegularExpression(pattern: #"[.!?…]+["')\]]*\s+|\n+"#)

    /// UTF-16 length of the next speakable chunk in text[from...], or 0 if none is ready yet.
    /// A sentence only counts as complete once whitespace follows its punctuation ("3.5" must not split).
    static func nextChunk(_ text: String, from: Int, done: Bool) -> Int {
        let ns = text as NSString
        guard from >= 0, from <= ns.length else { return 0 }
        let rest = ns.substring(from: from)
        let len = (rest as NSString).length
        var found = 0
        boundary.enumerateMatches(in: rest, range: NSRange(location: 0, length: len)) { m, _, stop in
            guard let m else { return }
            let end = m.range.location + m.range.length
            if end >= minChunk { found = end; stop.pointee = true }
        }
        if found > 0 { return found }
        return done && !rest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? len : 0
    }

    private static func words(_ s: String) -> [String] {
        s.lowercased().replacingOccurrences(of: "’", with: "'")
            .components(separatedBy: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "'")).inverted)
            .filter { !$0.isEmpty }
    }

    /// True when what the mic "heard" is mostly words the agent itself just said (its own voice coming back in).
    /// Needs 3+ words so a short "yes" / "ok" is never dropped.
    static func isEcho(_ heard: String, recent: String) -> Bool {
        let h = words(heard)
        guard h.count >= 3 else { return false }
        let r = Set(words(recent))
        return Double(h.filter(r.contains).count) / Double(h.count) >= 0.75
    }

    /// Markdown reply -> text worth reading aloud: no code blocks, links or markup symbols.
    static func speakable(_ md: String) -> String {
        var t = md
        t = t.replacingOccurrences(of: #"```[\s\S]*?(```|$)"#, with: "", options: .regularExpression)
        t = t.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]+\)"#, with: "$1", options: .regularExpression)
        t = t.replacingOccurrences(of: #"https?://\S+"#, with: "", options: .regularExpression)
        t = t.replacingOccurrences(of: #"[*_#`>|]"#, with: "", options: .regularExpression)
        t = t.replacingOccurrences(of: #"[ \t]+"#, with: " ", options: .regularExpression)
        return t
    }

    /// 16-bit PCM bytes -> WAV (some models, e.g. Gemini, only return raw PCM).
    static func wav(pcm: Data, rate: Int, channels: Int = 1) -> Data {
        func le32(_ v: Int) -> [UInt8] { (0..<4).map { UInt8((v >> (8 * $0)) & 0xff) } }
        func le16(_ v: Int) -> [UInt8] { (0..<2).map { UInt8((v >> (8 * $0)) & 0xff) } }
        var h = Data("RIFF".utf8)
        h += le32(36 + pcm.count); h += Data("WAVEfmt ".utf8)
        h += le32(16); h += le16(1); h += le16(channels)
        h += le32(rate); h += le32(rate * 2 * channels); h += le16(2 * channels); h += le16(16)
        h += Data("data".utf8); h += le32(pcm.count)
        return h + pcm
    }

    /// 16 kHz mono float samples -> 16-bit PCM WAV (what the speech-to-text endpoint takes).
    static func wav(samples: [Float]) -> Data {
        var pcm = Data(capacity: samples.count * 2)
        for s in samples {
            let v = Int16(max(-1, min(1, s)) * 32767)
            pcm.append(UInt8(truncatingIfNeeded: v)); pcm.append(UInt8(truncatingIfNeeded: v >> 8))
        }
        return wav(pcm: pcm, rate: 16000)
    }
}
