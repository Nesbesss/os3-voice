import Foundation
import WebKit

/// A second connection to the same OS3 conversation the web UI shows, used by the voice engine so it can
/// keep working while the web page is suspended in the background.
/// Handshake (same as the web UI): login cookie -> GET /api/auth/token -> POST /session-directory/route
/// -> wss://os3-<instance>.rabbit.tech/ws -> {type: init, accessToken, sessionId}.
/// The sessionId is the one the web UI keeps in localStorage ("rabbit-hole-session-id"), so both see one chat.
@MainActor final class OS3Socket {
    static let origin = URL(string: "https://os3.rabbit.tech")!
    // CloudFront 403s the default CFNetwork user agent.
    static let ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"

    var sessionId: String?
    var onFrame: (([String: Any]) -> Void)?
    private(set) var connected = false
    private(set) var lastProblem: String?
    private var ws: URLSessionWebSocketTask?
    private var loop: Task<Void, Never>?

    func start() {
        guard loop == nil else { return }
        loop = Task { await run(); loop = nil }
    }

    func stop() {
        loop?.cancel(); loop = nil
        ws?.cancel(with: .goingAway, reason: nil); ws = nil
        connected = false
    }

    /// False when we aren't connected (the caller shows an error instead of silently losing the message).
    @discardableResult func send(_ text: String) -> Bool {
        guard connected else { return false }
        write(["type": "chat.message", "text": text, "version": 1, "timestamp": Self.now])
        return true
    }

    private func run() async {
        var delay = 1.0
        while !Task.isCancelled {
            if let token = await token(), await session(token) { delay = 1 }
            connected = false
            try? await Task.sleep(for: .seconds(delay))
            delay = min(delay * 2, 30)
        }
    }

    private func session(_ token: String) async -> Bool {
        var req = URLRequest(url: await wsURL(token))
        req.setValue(Self.ua, forHTTPHeaderField: "User-Agent")
        let task = URLSession.shared.webSocketTask(with: req)
        ws = task
        task.resume()
        var hello: [String: Any] = ["type": "init", "version": 1, "timestamp": Self.now, "accessToken": token]
        if let sessionId { hello["sessionId"] = sessionId }
        write(hello)

        // a socket can die silently (sleep, Wi-Fi <-> cellular): no pong in 10s -> drop it
        let heartbeat = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(25))
                var ponged = false
                task.sendPing { err in Task { @MainActor in ponged = err == nil } }
                try? await Task.sleep(for: .seconds(10))
                if !ponged && !Task.isCancelled { task.cancel(with: .goingAway, reason: nil) }
            }
        }
        defer { heartbeat.cancel() }

        var acked = false
        while let frame = try? await task.receive() {
            guard case .string(let s) = frame,
                  let j = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any] else { continue }
            if j["type"] as? String == "init_ack" {
                connected = true; acked = true; lastProblem = nil
                if let id = j["sessionId"] as? String { sessionId = id }
            }
            onFrame?(j)
        }
        if ws === task { ws = nil }
        return acked
    }

    private func write(_ obj: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: obj) else { return }
        ws?.send(.string(String(decoding: d, as: UTF8.self))) { _ in }
    }

    // MARK: HTTP

    /// nil = not logged in (or offline); the loop retries.
    private func token() async -> String? {
        // the login happened in the web view: copy its cookies to the URLSession jar
        for c in await WKWebsiteDataStore.default().httpCookieStore.allCookies() where c.domain.hasSuffix("rabbit.tech") {
            HTTPCookieStorage.shared.setCookie(c)
        }
        var req = URLRequest(url: Self.origin.appending(path: "api/auth/token"))
        req.setValue(Self.ua, forHTTPHeaderField: "User-Agent")
        req.timeoutInterval = 15
        guard let (d, r) = try? await URLSession.shared.data(for: req), let code = (r as? HTTPURLResponse)?.statusCode else {
            lastProblem = "offline"; return nil
        }
        if code == 401 || code == 403 { lastProblem = "not logged in"; return nil }
        guard code == 200, let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let t = j["accessToken"] as? String, !t.isEmpty else { lastProblem = "server \(code)"; return nil }
        return t
    }

    /// The web UI asks which backend instance holds this user's session and rewrites the host
    /// os3.rabbit.tech -> os3-<instance>.rabbit.tech.
    private func wsURL(_ token: String) async -> URL {
        var host = Self.origin.host()!
        var req = URLRequest(url: Self.origin.appending(path: "session-directory/route"))
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue(Self.ua, forHTTPHeaderField: "User-Agent")
        req.timeoutInterval = 10
        if let (d, _) = try? await URLSession.shared.data(for: req),
           let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
           j["kind"] as? String == "route", let id = j["instanceId"] as? String, !id.isEmpty {
            let parts = host.split(separator: ".", maxSplits: 1)
            host = "\(parts[0])-\(id).\(parts[1])"
        }
        return URL(string: "wss://\(host)/ws")!
    }

    private static var now: Int { Int(Date().timeIntervalSince1970 * 1000) }
}
