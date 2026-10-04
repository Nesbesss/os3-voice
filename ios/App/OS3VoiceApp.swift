import SwiftUI

@main struct OS3VoiceApp: App {
    @StateObject private var bridge = Bridge.shared

    var body: some Scene {
        WindowGroup {
            WebContainer()
                .background(bridge.bg.ignoresSafeArea())            // same colour as the page: no black bars in light mode
                .preferredColorScheme(bridge.isLight ? .light : .dark)   // status bar text readable on it
                .ignoresSafeArea(.keyboard)
        }
    }
}
