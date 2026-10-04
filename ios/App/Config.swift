import Foundation
import Security

/// Voice settings, edited from Settings > Voice inside the OS3 web UI. The API key lives in the Keychain,
/// never in the page; everything else is a small dictionary in UserDefaults.
enum Cfg {
    static let defaults: [String: Any] = [
        "stt_model": "openai/whisper-large-v3",
        "tts_model": "google/gemini-3.8-flash-lite-tts",
        "voice": "Zephyr",
        "thresh": 0.02,         // mic loudness that counts as speech
        "end_silence_ms": 900,  // pause that ends your turn
        "max_chars": 700,       // spoken per reply; the rest stays on screen (cost cap)
        "barge_in": false,      // true = you can interrupt by speaking
        "tail_ms": 700,         // keep ignoring the mic this long after the last sound
    ]
    private static let store = "voiceCfg"

    static var all: [String: Any] {
        defaults.merging(UserDefaults.standard.dictionary(forKey: store) ?? [:]) { $1 }
    }
    static func str(_ k: String) -> String { all[k] as? String ?? "" }
    static func num(_ k: String) -> Double { (all[k] as? NSNumber)?.doubleValue ?? 0 }
    static func bool(_ k: String) -> Bool { (all[k] as? NSNumber)?.boolValue ?? false }

    private static func isBool(_ v: Any) -> Bool { (v as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() } ?? false }

    /// Only known fields with the right type are stored.
    static func apply(_ patch: [String: Any]) {
        var cur = UserDefaults.standard.dictionary(forKey: store) ?? [:]
        for (k, d) in defaults {
            guard let v = patch[k] else { continue }
            if d is String, v is String { cur[k] = v }
            else if isBool(d), isBool(v) { cur[k] = v }
            else if !(d is String), !isBool(d), !isBool(v), let n = v as? NSNumber, n.doubleValue.isFinite { cur[k] = n }
        }
        UserDefaults.standard.set(cur, forKey: store)
        if let k = patch["openrouter_key"] as? String, k.trimmingCharacters(in: .whitespaces).hasPrefix("sk-") {
            Keychain.save(k.trimmingCharacters(in: .whitespaces))
        }
    }

    /// What the settings page may see: no key, just whether there is one.
    static func publicDict() -> [String: Any] {
        var d = all
        let k = Keychain.load()
        d["has_key"] = k != nil
        d["key_hint"] = k.map { "…" + $0.suffix(4) } ?? ""
        return d
    }
}

enum Keychain {
    private static let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                               kSecAttrService as String: "os3voice.openrouter"]
    static func save(_ s: String) {
        SecItemDelete(query as CFDictionary)
        var q = query
        q[kSecValueData as String] = Data(s.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock   // readable while the phone is locked (background voice)
        SecItemAdd(q as CFDictionary, nil)
    }
    static func load() -> String? {
        var q = query; q[kSecReturnData as String] = true
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
}
