import ActivityKit
import AppIntents
import Foundation

/// Live Activity payload, shared by the app and the widget extension.
struct VoiceActivity: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var phase: String        // listening | hearing | thinking | speaking | error
        var detail: String       // what was heard / said / the error, one line
    }
    var name: String             // butler name
}

/// The Stop button on the Live Activity. LiveActivityIntents run inside the app's process
/// (which stays alive in the background because of the audio session), so a notification is enough.
struct StopVoiceIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Stop voice mode"
    func perform() async throws -> some IntentResult {
        NotificationCenter.default.post(name: .os3StopVoice, object: nil)
        return .result()
    }
}

extension Notification.Name {
    static let os3StopVoice = Notification.Name("os3.stopVoice")
}
