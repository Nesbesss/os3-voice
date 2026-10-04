import SwiftUI
import WebKit

/// The OS3 web UI in a WKWebView, plus a private channel for the injected voice UI (voice.js).
/// voice.js runs in its own content world: the page's own scripts can't see `webkit.messageHandlers.os3`.
@MainActor final class Bridge: NSObject, ObservableObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate {
    static let shared = Bridge()
    static let home = URL(string: "https://os3.rabbit.tech/")!

    let world = WKContentWorld.world(name: "os3voice")
    let webView: WKWebView
    private var modelsCache: [String: Any]?
    /// The page's background, so the bars around it (notch, home bar) match in light and dark mode.
    @Published var bg = Color(red: 0.075, green: 0.082, blue: 0.086)   // OS3 dark, until the page tells us
    @Published var isLight = false

    private func setBackground(_ rgb: [Double]) {
        guard rgb.count == 3 else { return }
        UserDefaults.standard.set(rgb, forKey: "pageBg")
        let ui = UIColor(red: rgb[0] / 255, green: rgb[1] / 255, blue: rgb[2] / 255, alpha: 1)
        bg = Color(ui)
        isLight = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) > 140
        webView.underPageBackgroundColor = ui     // rubber-band overscroll
        webView.scrollView.backgroundColor = ui
    }

    override init() {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()          // login survives relaunch
        cfg.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: cfg)
        super.init()
        let js = (Bundle.main.url(forResource: "voice", withExtension: "js")).flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
        cfg.userContentController.addScriptMessageHandler(self, contentWorld: world, name: "os3")
        cfg.userContentController.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: world))
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.isInspectable = true               // Safari > Develop > your iPhone, for debugging
        if let saved = UserDefaults.standard.array(forKey: "pageBg") as? [Double] { setBackground(saved) }   // no flash on relaunch
        webView.load(URLRequest(url: Self.home))
        VoiceEngine.shared.onPhase = { [weak self] p, d in self?.push(p, d) }
    }

    /// native -> page: update the headphone button
    private func push(_ p: VoiceEngine.Phase, _ detail: String) {
        let js = "window.__os3v && window.__os3v.state(\(Self.json(p.rawValue)), \(Self.json(detail)))"
        webView.evaluateJavaScript(js, in: nil, in: world, completionHandler: nil)
    }

    private static func json(_ s: String) -> String {
        (try? String(data: JSONSerialization.data(withJSONObject: [s]), encoding: .utf8)).flatMap { String($0.dropFirst().dropLast()) } ?? "\"\""
    }

    // MARK: page -> native

    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard let m = message.body as? [String: Any], let op = m["op"] as? String else { return (nil, "bad message") }
        let arg = m["arg"] as? [String: Any] ?? [:]
        let engine = VoiceEngine.shared
        switch op {
        case "cfg":
            var d = Cfg.publicDict()
            d["phase"] = engine.phase.rawValue
            return (d, nil)
        case "setcfg":
            Cfg.apply(arg)
            return (true, nil)
        case "models":
            do { return (try await models(), nil) } catch { return (nil, error.localizedDescription) }
        case "tts":
            do {
                try await engine.test(text: arg["text"] as? String ?? "Hi, this is how I sound.", model: arg["model"] as? String ?? Cfg.str("tts_model"),
                                      voice: arg["voice"] as? String ?? Cfg.str("voice"), key: arg["key"] as? String)
                return (true, nil)
            } catch { return (nil, (error as? VoiceError)?.message ?? error.localizedDescription) }
        case "bg":
            if let rgb = (arg["rgb"] as? [NSNumber])?.map(\.doubleValue) { setBackground(rgb) }
            return (true, nil)
        case "session":
            if let id = arg["id"] as? String, !id.isEmpty { engine.socket.sessionId = id }
            return (true, nil)
        case "toggle":
            if engine.isOn { if engine.phase == .speaking { engine.shutUp() } else { engine.stop() } } else { await engine.start() }
            return (true, nil)
        case "start": await engine.start(); return (true, nil)
        case "stop": engine.stop(); return (true, nil)
        default: return (nil, "unknown op \(op)")
        }
    }

    /// OpenRouter's public list of speech / transcription models, with prices and voices.
    private func models() async throws -> [String: Any] {
        if let modelsCache { return modelsCache }
        func get(_ kind: String) async throws -> [[String: Any]] {
            let (d, _) = try await URLSession.shared.data(from: URL(string: "https://openrouter.ai/api/v1/models?output_modalities=\(kind)")!)
            return (try JSONSerialization.jsonObject(with: d) as? [String: Any])?["data"] as? [[String: Any]] ?? []
        }
        func price(_ m: [String: Any], _ k: String) -> Double { Double(((m["pricing"] as? [String: Any])?[k] as? String) ?? "") ?? 0 }
        let tts: [[String: Any]] = try await get("speech").map { m in
            let p = price(m, "prompt"), c = price(m, "completion")
            // $ per 1M characters. Token-priced models (Gemini) are estimated: ~25 audio tokens per second of speech
            // at ~15 characters per second, plus ~1 text token per 4 characters.
            let perM = c == 0 ? p * 1e6 : (c * 25 / 15 + p / 4) * 1e6
            return ["id": m["id"] as? String ?? "", "name": m["name"] as? String ?? "", "est": c != 0,
                    "perM": perM < 500 ? perM : NSNull(), "voices": m["supported_voices"] as? [String] ?? []]
        }.sorted { (($0["perM"] as? Double) ?? 1e9) < (($1["perM"] as? Double) ?? 1e9) }
        let stt: [[String: Any]] = try await get("transcription").map { ["id": $0["id"] as? String ?? "", "name": $0["name"] as? String ?? ""] }
        let out: [String: Any] = ["tts": tts, "stt": stt]
        modelsCache = out
        return out
    }

    // MARK: navigation

    /// Links that leave OS3 open in Safari; the web view keeps the app.
    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        if action.navigationType == .linkActivated, let url = action.request.url, url.host?.hasSuffix("rabbit.tech") != true {
            await UIApplication.shared.open(url)
            return .cancel
        }
        return .allow
    }

    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if url.host?.hasSuffix("rabbit.tech") == true { w.load(action.request) } else { UIApplication.shared.open(url) }
        }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ w: WKWebView) { w.reload() }   // iOS reclaimed the page while we were in the background
}

struct WebContainer: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView { Bridge.shared.webView }
    func updateUIView(_ v: WKWebView, context: Context) {}
}
