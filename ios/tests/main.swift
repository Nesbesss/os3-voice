// swiftc -o /tmp/os3t App/Text.swift tests/main.swift && /tmp/os3t   - self-check for the pure logic in Text.swift
import Foundation

func check(_ ok: Bool, _ msg: String, line: Int = #line) {
    if !ok { print("FAIL line \(line): \(msg)"); exit(1) }
}

// waits for a full sentence of >= 30 chars; won't split "3.5"
let t = "The answer is about 3.5 percent overall, which is nice. Second sentence here"
let e = Speech.nextChunk(t, from: 0, done: false)
check((t as NSString).substring(to: e) == "The answer is about 3.5 percent overall, which is nice. ", "first chunk")
check(Speech.nextChunk(t, from: e, done: false) == 0, "unfinished tail waits while streaming")
check(Speech.nextChunk(t, from: e, done: true) == (t as NSString).length - e, "tail flushes once the reply is final")
check(Speech.nextChunk("Short. ", from: 0, done: false) == 0, "too short to speak yet")
check(Speech.nextChunk("Short.", from: 0, done: true) == 6, "flushed at the end")
check(Speech.nextChunk("   ", from: 0, done: true) == 0, "whitespace never spoken")
check(Speech.nextChunk("first line here is long enough to go\nsecond", from: 0, done: false) > 0, "newline ends a chunk")
check(Speech.nextChunk("abc", from: 99, done: true) == 0, "from past the end is safe")

// echo filter
let said = "Hey Sam, it's me. I looked into that for you, and I think I found a good option. Want me to walk you through it?"
check(Speech.isEcho("I think I found a good option", recent: said), "echo of its own words")
check(Speech.isEcho("want me to walk you through it", recent: said), "echo 2")
check(!Speech.isEcho("yes please walk me through it", recent: said), "real answer that overlaps a little")
check(!Speech.isEcho("what's the weather tomorrow", recent: said), "unrelated")
check(!Speech.isEcho("ok", recent: said) && !Speech.isEcho("sounds good", recent: said), "short replies never dropped")
check(!Speech.isEcho("anything at all here", recent: ""), "nothing said recently")

// speakable text
check(Speech.speakable("**Hi** [link](https://x.y/z) there") == "Hi link there", "markdown stripped: \(Speech.speakable("**Hi** [link](https://x.y/z) there"))")
check(!Speech.speakable("before\n```\ncode here\n```\nafter").contains("code"), "code blocks dropped")

// WAV header + clipping
let w = Speech.wav(samples: [0, 0.5, -2, 2])
check(String(decoding: w.prefix(4), as: UTF8.self) == "RIFF", "RIFF")
check(w.count == 44 + 8, "length")
check(Int(w[24]) | Int(w[25]) << 8 == 16000, "sample rate")
check(Int16(bitPattern: UInt16(w[48]) | UInt16(w[49]) << 8) == -32767, "-2 clipped to -1")
check(Int16(bitPattern: UInt16(w[50]) | UInt16(w[51]) << 8) == 32767, "+2 clipped to +1")
let g = Speech.wav(pcm: Data(count: 10), rate: 24000)
check(Int(g[24]) | Int(g[25]) << 8 | Int(g[26]) << 16 == 24000 && g.count == 54, "pcm wrap at 24 kHz")
print("ok")
