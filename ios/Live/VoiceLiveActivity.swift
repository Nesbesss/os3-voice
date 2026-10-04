import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main struct OS3VoiceWidgets: WidgetBundle {
    var body: some Widget { VoiceLiveActivity() }
}

private let orange = Color(red: 1, green: 0x46 / 255, blue: 0x12 / 255)   // rabbit accent

private func color(_ phase: String) -> Color {
    switch phase {
    case "hearing": .red
    case "thinking": .yellow
    case "speaking": .blue
    case "error": .red
    default: .green
    }
}

private func label(_ phase: String) -> String {
    switch phase {
    case "hearing": "Hearing you"
    case "thinking": "Thinking"
    case "speaking": "Speaking"
    case "error": "Problem"
    default: "Listening"
    }
}

/// Lock Screen banner + Dynamic Island while hands-free voice mode is on.
struct VoiceLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: VoiceActivity.self) { ctx in
            Banner(name: ctx.attributes.name, s: ctx.state)
                .activityBackgroundTint(.black)
                .activitySystemActionForegroundColor(orange)
        } dynamicIsland: { ctx in
            let s = ctx.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label(ctx.attributes.name, systemImage: "headphones").font(.caption.bold()).foregroundStyle(orange)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Button(intent: StopVoiceIntent()) { Image(systemName: "stop.fill") }.tint(.red)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(label(s.phase)).font(.subheadline.weight(.medium)).foregroundStyle(color(s.phase))
                        if !s.detail.isEmpty { Text(s.detail).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } compactLeading: {
                Image(systemName: "headphones").foregroundStyle(orange)
            } compactTrailing: {
                Circle().fill(color(s.phase)).frame(width: 10, height: 10)
            } minimal: {
                Circle().fill(color(s.phase)).frame(width: 10, height: 10)
            }
            .keylineTint(orange)
        }
    }
}

private struct Banner: View {
    let name: String
    let s: VoiceActivity.ContentState

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: "headphones").font(.title2).foregroundStyle(orange)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Circle().fill(color(s.phase)).frame(width: 9, height: 9)
                    Text("\(name) · \(label(s.phase))").font(.headline)
                }
                if !s.detail.isEmpty { Text(s.detail).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
            }
            Spacer()
            Button(intent: StopVoiceIntent()) { Image(systemName: "stop.fill").padding(10) }
                .buttonStyle(.plain).background(Circle().fill(.red.opacity(0.85)))
        }
        .padding()
        .foregroundStyle(.white)
    }
}
