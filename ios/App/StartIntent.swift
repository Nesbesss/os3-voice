import AppIntents

/// "Start hands-free": shows up in the Shortcuts app, Spotlight, the Action Button and Siri.
/// iOS only lets an app begin recording while it's in the foreground, so this opens the app and starts listening.
struct StartVoiceIntent: AppIntent {
    static var title: LocalizedStringResource = "Start hands-free"
    static var description = IntentDescription("Opens OS3 Voice and starts listening.")
    static var openAppWhenRun = true

    @MainActor func perform() async throws -> some IntentResult {
        _ = Bridge.shared   // make sure the web page (and its login) is loading
        await VoiceEngine.shared.start()
        return .result()
    }
}

struct OS3Shortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: StartVoiceIntent(),
                    phrases: ["Talk to \(.applicationName)", "Start \(.applicationName)", "Call \(.applicationName)"],
                    shortTitle: "Hands-free", systemImageName: "headphones")
    }
}
