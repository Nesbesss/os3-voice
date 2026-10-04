// Voice backend (appended to the app's main process). STT/TTS go through OpenRouter from here so the
// API key never reaches the web page. Config: ~/.os3-voice.json (chmod 600), edited from Settings > Voice.
"use strict";
const { ipcMain } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const CFG = path.join(os.homedir(), ".os3-voice.json");
const DEFAULTS = {
    stt_model: "openai/whisper-large-v3",
    tts_model: "google/gemini-3.8-flash-lite-tts", // "say" = free macOS voice, no API cost
    voice: "Zephyr",
    thresh: 0.02, // mic loudness that counts as speech; raise in noisy rooms, lower if it misses you
    end_silence_ms: 900, // pause that ends your turn
    max_chars: 700, // spoken per reply; the rest stays on screen (cost cap)
    barge_in: false, // true = you can interrupt by speaking (needs headphones, or it hears itself)
    tail_ms: 700, // keep ignoring the mic this long after the agent's last sound (room echo)
};
const read = () => {
    try {
        return JSON.parse(fs.readFileSync(CFG, "utf8"));
    } catch {
        return {};
    }
};
const cfg = () => ({ ...DEFAULTS, ...read() });
const USAGE = path.join(os.homedir(), ".os3-voice-usage.jsonl"); // one line per call: what was sent, never what was said
const log = (rec) => fs.appendFile(USAGE, JSON.stringify({ t: Date.now(), ...rec }) + "\n", { mode: 0o600 }, () => {});
const realKey = (k) => (typeof k === "string" && k.startsWith("sk-") ? k : "");

async function api(kind, body, keyOverride) {
    const key = realKey(keyOverride) || realKey(cfg().openrouter_key) || process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("No API key yet: add one in Settings > Voice");
    const r = await fetch("https://openrouter.ai/api/v1/audio/" + kind, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${kind} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r;
}

ipcMain.handle("os3:voice:cfg", () => {
    const { openrouter_key, ...pub } = cfg();
    const k = realKey(openrouter_key);
    return { ...pub, has_key: !!k, key_hint: k ? "…" + k.slice(-4) : "" };
});

// Only known fields, right types. An empty key field means "keep the saved one".
ipcMain.handle("os3:voice:setcfg", (_e, patch) => {
    const cur = read();
    for (const k of Object.keys(DEFAULTS)) {
        const v = patch[k];
        if (typeof v === typeof DEFAULTS[k] && (typeof v !== "number" || Number.isFinite(v))) cur[k] = v;
    }
    if (typeof patch.openrouter_key === "string" && realKey(patch.openrouter_key.trim()))
        cur.openrouter_key = patch.openrouter_key.trim();
    fs.writeFileSync(CFG, JSON.stringify(cur, null, 2) + "\n", { mode: 0o600 });
    fs.chmodSync(CFG, 0o600);
    return true;
});

// Live list of OpenRouter speech/transcription models (public, no key) + this Mac's voices.
let modelsCache;
const tokenPriced = (m) => Number(m.pricing.completion) !== 0;
// ponytail: 1.26 = one measured Gemini Flash-Lite reply cost 26% more than the token math says; re-measure if the estimate drifts
const estPerM = (m) => {
    const v = (Number(m.pricing.completion) * (25 / 16.5) + Number(m.pricing.prompt) / 4) * 1e6 * 1.26;
    return v < 500 ? v : null; // absurd values mean the price isn't per token after all
};
const sayVoices = () =>
    new Promise((res) =>
        execFile("say", ["-v", "?"], (e, out) =>
            res(e ? [] : out.split("\n").map((l) => (l.match(/^(.+?)\s{2,}\S+\s+#/) || [])[1]).filter(Boolean)),
        ),
    );
async function modelList() {
    if (!modelsCache) {
        const get = async (m) => (await (await fetch(`https://openrouter.ai/api/v1/models?output_modalities=${m}`)).json()).data || [];
        const [tts, stt] = await Promise.all([get("speech"), get("transcription")]);
        modelsCache = {
            tts: tts
                .map((m) => ({
                    id: m.id,
                    name: m.name,
                    // $ per 1M characters. Token-priced models (Gemini) are estimated: ~25 audio tokens per second
                    // of speech at ~16.5 characters per second, plus ~1 text token per 4 characters, times a measured correction.
                    perM: tokenPriced(m) ? estPerM(m) : Number(m.pricing.prompt) * 1e6,
                    est: tokenPriced(m),
                    voices: m.supported_voices || [],
                }))
                .sort((a, b) => (a.perM ?? 1e9) - (b.perM ?? 1e9)),
            stt: stt.map((m) => ({ id: m.id, name: m.name })),
        };
    }
    return modelsCache;
}
ipcMain.handle("os3:voice:models", async () => ({ ...(await modelList()), say: await sayVoices() }));

ipcMain.handle("os3:voice:stt", async (_e, wav) => {
    const r = await api("transcriptions", {
        model: cfg().stt_model,
        input_audio: { data: Buffer.from(wav).toString("base64"), format: "wav" },
    });
    const j = await r.json();
    log({ k: "stt", model: cfg().stt_model, secs: j.usage?.seconds, cost: j.usage?.cost }); // OpenRouter reports the exact cost here
    return (j.text || "").trim();
});

// Some models (Gemini) only return raw 16-bit mono PCM; wrap it in a WAV header so the page can decode it.
function wavFromPcm(pcm, rate) {
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([h, pcm]);
}

// arg: a string, or {text, model?, voice?, key?} (the Settings "test voice" button uses unsaved values)
ipcMain.handle("os3:voice:tts", (_e, arg) => {
    const o = typeof arg === "string" ? { text: arg } : arg;
    const c = { ...cfg(), ...(o.model && { tts_model: o.model }), ...(o.voice !== undefined && { voice: o.voice }) };
    if (c.tts_model === "say")
        return new Promise((res, rej) => {
            const f = path.join(os.tmpdir(), `os3say-${process.pid}-${Date.now()}.wav`);
            const v = c.voice ? ["-v", c.voice] : [];
            execFile("say", [...v, "-o", f, "--file-format=WAVE", "--data-format=LEI16@22050", "--", o.text], (e) => {
                if (e) return rej(e);
                const b = fs.readFileSync(f);
                fs.unlink(f, () => {});
                log({ k: "tts", model: "say", chars: o.text.length });
                res(b);
            });
        });
    const format = c.tts_model.startsWith("google/") ? "pcm" : "mp3"; // Gemini TTS rejects mp3
    return api("speech", { model: c.tts_model, input: o.text, voice: c.voice, response_format: format }, o.key).then(async (r) => {
        const buf = Buffer.from(await r.arrayBuffer());
        const ct = r.headers.get("content-type") || "";
        log({ k: "tts", model: c.tts_model, chars: o.text.length });
        return ct.startsWith("audio/pcm") ? wavFromPcm(buf, +(ct.match(/rate=(\d+)/) || [])[1] || 24000) : buf;
    });
});

// recs: parsed log lines; perM: model id -> estimated $ per 1M characters. Splits into today (local time) and all time.
function aggregate(recs, perM, now = Date.now()) {
    const day = new Date(now).toDateString();
    const zero = () => ({ replies: 0, chars: 0, ttsCost: 0, heard: 0, sttCost: 0 });
    const out = { today: zero(), total: zero() };
    for (const r of recs) {
        for (const b of new Date(r.t).toDateString() === day ? [out.total, out.today] : [out.total]) {
            if (r.k === "tts") { b.replies++; b.chars += r.chars || 0; b.ttsCost += ((perM[r.model] || 0) * (r.chars || 0)) / 1e6; }
            else if (r.k === "stt") { b.heard++; b.sttCost += r.cost || 0; }
        }
    }
    return out;
}

ipcMain.handle("os3:voice:usage", async () => {
    let recs = [];
    try {
        recs = fs.readFileSync(USAGE, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch {}
    const models = await modelList().catch(() => ({ tts: [] }));
    const out = aggregate(recs, Object.fromEntries(models.tts.map((x) => [x.id, x.perM || 0])));
    // OpenRouter's own total for this key: the real number, though it lags a few minutes and counts anything else using the key
    let key = null;
    const k = realKey(cfg().openrouter_key);
    if (k) {
        try {
            const j = await (await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${k}` } })).json();
            key = { usage: j.data.usage, limit: j.data.limit };
        } catch {}
    }
    return { ...out, key, since: recs[0]?.t };
});

module.exports = { aggregate }; // node self-check (test.js)
