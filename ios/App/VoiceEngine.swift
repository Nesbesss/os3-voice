import ActivityKit
import AVFoundation
import UIKit

struct VoiceError: LocalizedError {
    let message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}

/// OpenRouter audio endpoints (called from native code so the API key never reaches the web page).
enum OR {
    static func post(_ path: String, _ body: [String: Any], key: String) async throws -> (Data, String) {
        var req = URLRequest(url: URL(string: "https://openrouter.ai/api/v1/audio/\(path)")!)
        req.httpMethod = "POST"
        req.timeoutInterval = 60
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (d, r) = try await URLSession.shared.data(for: req)
        guard let http = r as? HTTPURLResponse, http.statusCode == 200 else {
            let code = (r as? HTTPURLResponse)?.statusCode ?? 0
            throw VoiceError("\(path) \(code): " + String(decoding: d.prefix(160), as: UTF8.self))
        }
        return (d, http.value(forHTTPHeaderField: "Content-Type") ?? "")
    }

    static func transcribe(_ wav: Data, key: String) async throws -> String {
        let (d, _) = try await post("transcriptions", ["model": Cfg.str("stt_model"),
                                                       "input_audio": ["data": wav.base64EncodedString(), "format": "wav"]], key: key)
        return ((try JSONSerialization.jsonObject(with: d) as? [String: Any])?["text"] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Audio bytes AVFoundation can decode (mp3, or WAV wrapped around the raw PCM that Gemini returns) + file extension.
    static func speech(_ text: String, model: String, voice: String, key: String) async throws -> (Data, String) {
        let format = model.hasPrefix("google/") ? "pcm" : "mp3"   // Gemini TTS rejects mp3
        let (d, ct) = try await post("speech", ["model": model, "input": text, "voice": voice, "response_format": format], key: key)
        guard ct.hasPrefix("audio/pcm") else { return (d, "mp3") }
        let rate = ct.range(of: #"rate=(\d+)"#, options: .regularExpression).flatMap { Int(ct[$0].dropFirst(5)) } ?? 24000
        return (Speech.wav(pcm: d, rate: rate), "wav")
    }
}

/// Mic buffers (audio thread) -> 16 kHz mono frames of 2048 samples (128 ms) for the speech detector.
final class Capture {
    static let out = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
    static let frame = 2048
    private let mono: AVAudioFormat
    private let conv: AVAudioConverter
    private var acc: [Float] = []

    init?(input: AVAudioFormat) {
        guard let m = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: input.sampleRate, channels: 1, interleaved: false),
              let c = AVAudioConverter(from: m, to: Capture.out) else { return nil }
        mono = m; conv = c
    }

    func feed(_ buf: AVAudioPCMBuffer) -> [[Float]] {
        guard let ch = buf.floatChannelData, buf.frameLength > 0,
              let src = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buf.frameLength) else { return [] }
        src.frameLength = buf.frameLength
        src.floatChannelData![0].update(from: ch[0], count: Int(buf.frameLength))   // first channel is the processed mic
        let cap = AVAudioFrameCount(Double(buf.frameLength) * 16000 / mono.sampleRate) + 16
        guard let dst = AVAudioPCMBuffer(pcmFormat: Capture.out, frameCapacity: cap) else { return [] }
        var fed = false
        var err: NSError?
        conv.convert(to: dst, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData; return src
        }
        guard err == nil, let d = dst.floatChannelData?[0] else { return [] }
        acc.append(contentsOf: UnsafeBufferPointer(start: d, count: Int(dst.frameLength)))
        var frames: [[Float]] = []
        while acc.count >= Self.frame { frames.append(Array(acc.prefix(Self.frame))); acc.removeFirst(Self.frame) }
        return frames
    }
}

/// Hands-free voice: mic -> speech detector -> OpenRouter transcription -> OS3 chat; OS3's small-model replies
/// -> sentence chunks -> OpenRouter speech -> speaker. Runs in the background (audio session) with a Live Activity.
/// Echo is handled in layers: iOS voice processing (hardware echo cancellation), a deaf window while the agent
/// talks, and a transcript check that drops anything that is just the agent's own words.
@MainActor final class VoiceEngine {
    static let shared = VoiceEngine()
    enum Phase: String { case off, listening, hearing, thinking, speaking, error }

    private(set) var isOn = false
    private(set) var phase: Phase = .off
    var onPhase: ((Phase, String) -> Void)?
    let socket = OS3Socket()

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let playFormat = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
    private var capture: Capture?

    // speech detector
    private static let frameMs = Double(Capture.frame) / 16000 * 1000
    private var pre: [[Float]] = []
    private var utt: (frames: [[Float]], voiced: Int)?
    private var silent = 0
    private var loud = 0

    // speaking
    private var epoch = 0
    private var inflight = 0
    private var chain: Task<Void, Never>?
    private var playToken = 0
    private var playDone: (() -> Void)?
    private var lastPlayEnd = Date.distantPast
    private var spoken: [(t: Date, text: String)] = []

    // replies from OS3
    private struct Reply {
        var text = ""
        var from = 0
        var changed = Date()
        let born = Date()
        var final = false
        var done = false
    }
    private var replies: [String: Reply] = [:]
    private var seen = Set<String>()
    private var timer: Timer?
    private var name = "rabbit"
    private var activity: Activity<VoiceActivity>?
    private var lastActivity: VoiceActivity.ContentState?
    private var testPlayer: AVAudioPlayer?

    private init() {
        socket.onFrame = { [weak self] j in self?.handle(j) }
        let nc = NotificationCenter.default
        nc.addObserver(forName: .os3StopVoice, object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.stop() } }
        nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] n in
            let began = (n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.began.rawValue
            Task { @MainActor in self?.interrupted(began) }
        }
        nc.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.rebuild() }
        }
    }

    // MARK: on / off

    func start() async {
        guard !isOn else { return }
        guard Keychain.load() != nil else { return fail("Add your OpenRouter key in Settings → Voice") }
        guard await AVAudioApplication.requestRecordPermission() else { return fail("Microphone is off for this app: turn it on in iPhone Settings") }
        do { try buildGraph() } catch { return fail("Couldn't start the microphone: \(error.localizedDescription)") }
        isOn = true
        seen.removeAll(); replies.removeAll()   // replies already on screen are history; only speak new ones
        pre = []; utt = nil; silent = 0; loud = 0
        socket.start()
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in Task { @MainActor in self?.tick() } }
        startActivity()
        setPhase(.listening, "")
    }

    func stop() {
        guard isOn else { return }
        isOn = false
        shutUp()
        timer?.invalidate(); timer = nil
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        socket.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        setPhase(.off, "")
        endActivity()
    }

    private func fail(_ msg: String) {
        setPhase(.error, msg)
        Task {
            try? await Task.sleep(for: .seconds(8))
            if phase == .error { setPhase(isOn ? .listening : .off, "") }
        }
    }

    private func setPhase(_ p: Phase, _ detail: String) {
        phase = p
        onPhase?(p, detail)
        updateActivity(p, detail)
    }

    // MARK: audio graph

    private func buildGraph() throws {
        let s = AVAudioSession.sharedInstance()
        // voiceChat mode = iOS echo cancellation + noise suppression, routed to the speaker unless headphones are in
        try s.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try s.setActive(true)
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        try engine.inputNode.setVoiceProcessingEnabled(true)
        if player.engine == nil { engine.attach(player) }
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)
        let inFmt = engine.inputNode.outputFormat(forBus: 0)
        guard inFmt.sampleRate > 0, inFmt.channelCount > 0, let cap = Capture(input: inFmt) else { throw VoiceError("no microphone available") }
        capture = cap
        engine.inputNode.installTap(onBus: 0, bufferSize: 2048, format: inFmt) { [weak self] buf, _ in
            let frames = cap.feed(buf)
            guard !frames.isEmpty else { return }
            Task { @MainActor in frames.forEach { self?.onFrame($0) } }
        }
        engine.prepare()
        try engine.start()
    }

    private func rebuild() {   // route change (headphones in/out), media services reset...
        guard isOn else { return }
        do { try buildGraph() } catch { fail("Audio stopped: \(error.localizedDescription)") }
    }

    private func interrupted(_ began: Bool) {   // phone call, Siri, alarm
        guard isOn else { return }
        if began { shutUp(); return }
        rebuild()
    }

    // MARK: listening

    private func deaf() -> Bool {
        inflight > 0
            || replies.values.contains { !$0.done && Date().timeIntervalSince($0.born) < 30 }   // reply still streaming in
            || Date().timeIntervalSince(lastPlayEnd) < Cfg.num("tail_ms") / 1000
    }

    private func onFrame(_ f: [Float]) {
        guard isOn else { return }
        var s: Float = 0
        for x in f { s += x * x }
        let rms = Double((s / Float(f.count)).squareRoot())
        let thresh = Cfg.num("thresh")
        if utt == nil {
            pre.append(f); if pre.count > 4 { pre.removeFirst() }   // keep ~250ms before the trigger so word starts aren't clipped
            if deaf() {
                if !Cfg.bool("barge_in") { pre = []; loud = 0; return }   // half-duplex: don't listen while the agent talks
                loud = rms > thresh * 3 ? loud + 1 : 0                    // interrupting needs sustained speech well above the echo level
                if loud >= 3 { shutUp(); loud = 0; utt = (Array(pre.suffix(4)), 3); silent = 0; setPhase(.hearing, "") }
                return
            }
            loud = 0
            if rms > thresh { utt = (Array(pre.suffix(3)), 1); silent = 0; setPhase(.hearing, "") }
            return
        }
        utt!.frames.append(f)
        if rms > thresh { utt!.voiced += 1; silent = 0 } else { silent += 1 }
        if Double(silent) * Self.frameMs >= Cfg.num("end_silence_ms") || Double(utt!.frames.count) * Self.frameMs > 60_000 { finishUtterance() }
    }

    private func finishUtterance() {
        guard let u = utt else { return }
        utt = nil; pre = []; silent = 0
        guard u.voiced >= 3 else { return setPhase(speaking() ? .speaking : .listening, "") }   // click/cough, not speech
        let wav = Speech.wav(samples: u.frames.flatMap { $0 })
        setPhase(.thinking, "")
        Task { await transcribe(wav) }
    }

    private func transcribe(_ wav: Data) async {
        guard let key = Keychain.load() else { return fail("Add your OpenRouter key in Settings → Voice") }
        do {
            let text = try await OR.transcribe(wav, key: key)
            let junk = text.range(of: #"^(thank you|thanks for watching|you)[.!]?$"#, options: [.regularExpression, .caseInsensitive]) != nil
            spoken.removeAll { Date().timeIntervalSince($0.t) > 60 }
            if text.count < 2 || junk {
                // nothing real was said
            } else if Speech.isEcho(text, recent: spoken.map(\.text).joined(separator: " ")) {
                print("[voice] dropped echo of the agent's own voice:", text)
            } else {
                guard socket.send(text) else {
                    return fail(socket.lastProblem == "not logged in" ? "Log in to OS3 in the app first" : "Not connected to OS3 yet, try again")
                }
                return setPhase(.thinking, text)
            }
        } catch { return fail((error as? VoiceError)?.message ?? error.localizedDescription) }
        if isOn { setPhase(speaking() ? .speaking : .listening, "") }
    }

    // MARK: replies from OS3

    private func handle(_ j: [String: Any]) {
        switch j["type"] as? String {
        case "init_ack":
            if let n = j["butlerName"] as? String { name = n }
        case "session.history":
            for m in j["messages"] as? [[String: Any]] ?? [] { if let id = m["messageId"] as? String { seen.insert(id) } }
        case "chat.message":
            guard let id = j["messageId"] as? String else { return }
            guard isOn, (j["role"] as? String ?? "agent") == "agent" else { seen.insert(id); return }
            track(id, text: j["text"] as? String ?? "", replace: true, final: true)
        case "chat.message_stream":
            guard let id = j["messageId"] as? String, let delta = j["delta"] as? String else { return }
            guard isOn else { seen.insert(id); return }
            track(id, text: delta, replace: false, final: j["done"] as? Bool == true)
        case "conversation.processing":
            if phase == .thinking { setPhase(.thinking, j["label"] as? String ?? "") }
        case "conversation.idle":
            if phase == .thinking { setPhase(.listening, "") }
        default: break
        }
    }

    private func track(_ id: String, text: String, replace: Bool, final: Bool) {
        if replies[id] == nil {
            guard !seen.contains(id) else { return }   // already spoken, or history after a reconnect
            seen.insert(id)
        }
        var r = replies[id] ?? Reply()
        if replace { r.text = text } else { r.text += text }
        r.changed = Date()
        r.final = r.final || final
        replies[id] = r
    }

    private func tick() {
        let maxChars = Int(Cfg.num("max_chars"))
        for (id, r0) in replies {
            var r = r0
            if r.done || Date().timeIntervalSince(r.born) > 120 { replies[id] = nil; continue }
            let clean = Speech.speakable(r.text)
            let stable = r.final || (!clean.isEmpty && Date().timeIntervalSince(r.changed) > 1.2)
            var end = 0
            repeat {
                end = r.from < maxChars ? Speech.nextChunk(clean, from: r.from, done: stable) : 0
                if end > 0 {
                    let piece = (clean as NSString).substring(with: NSRange(location: r.from, length: end)).trimmingCharacters(in: .whitespacesAndNewlines)
                    r.from += end
                    if !piece.isEmpty { say(piece) }
                }
            } while end > 0
            if stable && (r.from >= (clean as NSString).length || r.from >= maxChars) { r.done = true; replies[id] = nil } else { replies[id] = r }
        }
    }

    // MARK: speaking

    private func speaking() -> Bool { inflight > 0 }

    private func say(_ text: String) {
        guard let key = Keychain.load() else { return }
        let mine = epoch
        let model = Cfg.str("tts_model"), voice = Cfg.str("voice"), fmt = playFormat
        inflight += 1
        spoken.append((Date(), text))
        // the fetch starts now; playback below stays in order
        let fetch = Task.detached { () -> AVAudioPCMBuffer in
            let (data, ext) = try await OR.speech(text, model: model, voice: voice, key: key)
            return try Self.decode(data, ext: ext, to: fmt)
        }
        let prev = chain
        chain = Task { @MainActor in
            await prev?.value
            defer { inflight -= 1; lastPlayEnd = Date(); if inflight == 0, isOn, phase == .speaking { setPhase(.listening, "") } }
            guard mine == epoch else { fetch.cancel(); return }
            do {
                let buf = try await fetch.value
                guard mine == epoch, isOn else { return }
                setPhase(.speaking, text)
                await play(buf)
            } catch { if mine == epoch { setPhase(.error, (error as? VoiceError)?.message ?? error.localizedDescription) } }
        }
    }

    private func play(_ buf: AVAudioPCMBuffer) async {
        if !engine.isRunning { try? engine.start() }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            var once = false
            playToken += 1
            let token = playToken
            playDone = { if !once { once = true; c.resume() } }
            player.scheduleBuffer(buf, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.playToken == token else { return }
                    self.playDone?(); self.playDone = nil
                }
            }
            if !player.isPlaying { player.play() }
        }
    }

    /// Stop talking now and drop the rest of the reply (barge-in, tap on the button, Stop on the Live Activity).
    func shutUp() {
        epoch += 1
        for (id, var r) in replies { r.done = true; replies[id] = r }
        playToken += 1
        player.stop()
        playDone?(); playDone = nil
    }

    private nonisolated static func decode(_ data: Data, ext: String, to fmt: AVAudioFormat) throws -> AVAudioPCMBuffer {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "." + ext)
        try data.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let file = try AVAudioFile(forReading: url)
        guard let src = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
              let conv = AVAudioConverter(from: file.processingFormat, to: fmt) else { throw VoiceError("couldn't decode the audio") }
        try file.read(into: src)
        let cap = AVAudioFrameCount(Double(src.frameLength) * fmt.sampleRate / file.processingFormat.sampleRate) + 1024
        guard let dst = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: cap) else { throw VoiceError("couldn't decode the audio") }
        var fed = false
        var err: NSError?
        conv.convert(to: dst, error: &err) { _, status in
            if fed { status.pointee = .endOfStream; return nil }
            fed = true; status.pointee = .haveData; return src
        }
        if let err { throw err }
        return dst
    }

    /// "Test voice" button in Settings: speaks a sample with the (maybe unsaved) choices; works with voice mode off.
    func test(text: String, model: String, voice: String, key: String?) async throws {
        guard let key = (key?.hasPrefix("sk-") == true ? key : nil) ?? Keychain.load() else { throw VoiceError("Add your OpenRouter key first") }
        let (data, _) = try await OR.speech(text, model: model, voice: voice, key: key)
        if !isOn { try AVAudioSession.sharedInstance().setCategory(.playback); try AVAudioSession.sharedInstance().setActive(true) }
        let p = try AVAudioPlayer(data: data)
        testPlayer = p
        p.play()
        while p.isPlaying { try await Task.sleep(for: .milliseconds(150)) }
        if !isOn { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    }

    // MARK: Live Activity

    private func startActivity() {
        guard ActivityAuthorizationInfo().areActivitiesEnabled, activity == nil else { return }
        let state = VoiceActivity.ContentState(phase: "listening", detail: "")
        lastActivity = state
        activity = try? Activity.request(attributes: VoiceActivity(name: name), content: .init(state: state, staleDate: nil))
    }

    private func updateActivity(_ p: Phase, _ detail: String) {
        guard let activity, p != .off else { return }
        let state = VoiceActivity.ContentState(phase: p.rawValue, detail: String(detail.prefix(120)))
        guard state != lastActivity else { return }   // ActivityKit throttles; only send real changes
        lastActivity = state
        Task { await activity.update(.init(state: state, staleDate: nil)) }
    }

    private func endActivity() {
        let a = activity
        activity = nil; lastActivity = nil
        Task { await a?.end(nil, dismissalPolicy: .immediate) }
    }
}
