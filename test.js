// node test.js  - self-check for the pure logic in addon/voice-preload.js and addon/voice-main.js
const assert = require("assert");
const { nextChunk, toWav, isEcho } = require("./addon/voice-preload.js");

// waits for a full sentence of >= 30 chars; won't split "3.5"
const t = "The answer is about 3.5 percent overall, which is nice. Second sentence here";
let e = nextChunk(t, 0, false);
assert.strictEqual(t.slice(0, e), "The answer is about 3.5 percent overall, which is nice. ");
assert.strictEqual(nextChunk(t, e, false), 0); // unfinished tail waits while streaming...
assert.strictEqual(nextChunk(t, e, true), t.length - e); // ...and flushes once the reply is stable
assert.strictEqual(nextChunk("Short. ", 0, false), 0); // too short to speak yet
assert.strictEqual(nextChunk("Short.", 0, true), 6); // but flushed at the end
assert.strictEqual(nextChunk("   ", 0, true), 0); // whitespace never spoken
assert.ok(nextChunk("first line here is long enough to go\nsecond", 0, false) > 0); // newline ends a chunk

// WAV: header fields + clipping
const w = toWav(new Float32Array([0, 0.5, -2, 2]));
const d = new DataView(w.buffer);
assert.strictEqual(String.fromCharCode(...w.slice(0, 4)), "RIFF");
assert.strictEqual(d.getUint32(24, true), 16000);
assert.strictEqual(d.getUint32(40, true), 8);
assert.strictEqual(w.length, 44 + 8);
assert.strictEqual(d.getInt16(44 + 4, true), -32767); // -2 clipped to -1
assert.strictEqual(d.getInt16(44 + 6, true), 32767);
// echo filter: its own voice coming back is dropped, real replies and short answers are not
const said = "Hey Sam, it's me. I looked into that for you, and I think I found a good option. Want me to walk you through it?";
assert.ok(isEcho("I think I found a good option", said));
assert.ok(isEcho("want me to walk you through it", said));
assert.ok(!isEcho("yes please walk me through it", said)); // overlaps a little, but it's you
assert.ok(!isEcho("what's the weather tomorrow", said));
assert.ok(!isEcho("ok", said) && !isEcho("sounds good", said)); // short replies never dropped
assert.ok(!isEcho("anything at all here", "")); // nothing said recently
// usage totals: today vs all time, per-model price, exact STT cost
const Module = require("module");
const load = Module._load;
Module._load = function (req, ...a) { return req === "electron" ? { ipcMain: { handle() {} } } : load.call(this, req, ...a); };
const { aggregate } = require("./addon/voice-main.js");
const now = new Date(2026, 9, 4, 15).getTime(), yesterday = new Date(2026, 9, 3, 15).getTime();
const u = aggregate([
    { t: now, k: "tts", model: "m1", chars: 500 },
    { t: yesterday, k: "tts", model: "m1", chars: 1000 },
    { t: now, k: "tts", model: "say", chars: 200 }, // free voice: counted, costs nothing
    { t: now, k: "stt", cost: 0.001 },
    { t: yesterday, k: "stt", cost: 0.002 },
], { m1: 10 }, now);
assert.deepStrictEqual([u.today.replies, u.today.chars, u.today.heard], [2, 700, 1]);
assert.deepStrictEqual([u.total.replies, u.total.chars, u.total.heard], [3, 1700, 2]);
assert.ok(Math.abs(u.today.ttsCost - 0.005) < 1e-9 && Math.abs(u.total.ttsCost - 0.015) < 1e-9);
assert.ok(Math.abs(u.today.sttCost - 0.001) < 1e-9 && Math.abs(u.total.sttCost - 0.003) < 1e-9);
assert.strictEqual(aggregate([], {}).total.replies, 0);
console.log("ok");
