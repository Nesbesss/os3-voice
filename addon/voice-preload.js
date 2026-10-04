// Voice mode (appended to the app's sandboxed preload). Mic -> VAD -> STT -> chat box -> send;
// the small model's streamed reply is read from the DOM and spoken sentence by sentence.
// UI: headphone button next to send (click = hands-free on/off, right-click = menu) + Settings > Voice.
(() => {
    const MIN_CHUNK = 30; // chars; don't speak fragments shorter than this while streaming

    // Index just past the next speakable chunk in text[from..], or 0 if none is ready yet.
    // A sentence only counts as complete once whitespace follows its punctuation ("3.5" must not split).
    function nextChunk(text, from, done) {
        const rest = text.slice(from);
        const re = /[.!?…]+["')\]]*\s+|\n+/g;
        let m;
        while ((m = re.exec(rest))) if (m.index + m[0].length >= MIN_CHUNK) return m.index + m[0].length;
        return done && rest.trim() ? rest.length : 0;
    }

    // True when what the mic "heard" is mostly words the agent itself just said (its own voice coming back in).
    // Needs 3+ words so a short "yes" / "ok" is never dropped.
    function isEcho(heard, recent) {
        const words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean);
        const h = words(heard);
        if (h.length < 3) return false;
        const r = new Set(words(recent));
        return h.filter((w) => r.has(w)).length / h.length >= 0.75;
    }

    // 16 kHz mono float32 -> 16-bit PCM WAV bytes.
    function toWav(f) {
        const n = f.length, b = new DataView(new ArrayBuffer(44 + n * 2));
        const w = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
        w(0, "RIFF"); b.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt ");
        b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
        b.setUint32(24, 16000, true); b.setUint32(28, 32000, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true);
        w(36, "data"); b.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) b.setInt16(44 + i * 2, Math.max(-1, Math.min(1, f[i])) * 0x7fff, true);
        return new Uint8Array(b.buffer);
    }

    if (typeof document === "undefined") {
        module.exports = { nextChunk, toWav, isEcho }; // node self-check (test.js)
        return;
    }

    if (location.origin !== "https://os3.rabbit.tech") return; // the add-on is loaded into every page of the app; only OS3 gets the UI

    const { ipcRenderer } = require("electron");
    const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
    const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
    const SEL = '.dial-msg[data-structure-key="text|butler"]'; // the small conversation model's messages
    const FRAME = 2048, RATE = 16000, FRAME_MS = (FRAME / RATE) * 1000;
    let C = { thresh: 0.02, end_silence_ms: 900, max_chars: 700, barge_in: false, tail_ms: 700 };
    let on = false, stream, ctxIn, proc, pre = [], utt = null, silent = 0;
    let ctxOut, epoch = 0, chain = Promise.resolve(), inflight = 0, playing = null, lastPlayEnd = 0, loud = 0, spoken = [];
    let tracked = new Map(), seen = new Set(), timer;
    const loadCfg = () => invoke("os3:voice:cfg").then((c) => { C = { ...C, ...c }; return c; });
    loadCfg().catch(() => {});

    // ---------- headphone button + status ----------
    const HEADPHONES = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="7" rx="1.6"/><rect x="17" y="14" width="4" height="7" rx="1.6"/></svg>';
    const CSS = `
.os3-voice-btn{flex:none;width:calc(var(--btn,56px)*.9);height:calc(var(--btn,56px)*.9);border-radius:50%;border:1px solid var(--border,#888);background:transparent;color:var(--control-icon,#888);display:grid;place-items:center;padding:0;cursor:var(--cursor-pointer,pointer);transition:background .15s,color .15s,border-color .15s;-webkit-app-region:no-drag}
.os3-voice-btn:hover{border-color:var(--text,#000);color:var(--text,#000)}
.os3-voice-btn svg{width:46%;height:46%}
.os3-voice-btn:not([data-state=off]) svg rect{fill:currentColor}
.os3-voice-btn:not([data-state=off]){color:#fff;border-color:transparent}
.os3-voice-btn[data-state=listening]{background:var(--green,#2e9e5b);animation:os3vpulse 2.4s ease-out infinite}
.os3-voice-btn[data-state=hearing]{background:var(--red,#d9534f)}
.os3-voice-btn[data-state=thinking]{background:var(--yellow,#c9a227)}
.os3-voice-btn[data-state=speaking]{background:var(--blue,#3b82f6)}
.os3-voice-btn[data-state=error]{background:var(--red,#8b0000);outline:2px solid var(--red,#8b0000);outline-offset:2px}
@keyframes os3vpulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--green,#2e9e5b) 55%,transparent)}70%,100%{box-shadow:0 0 0 14px transparent}}
#os3-voice-label{position:fixed;z-index:300;max-width:360px;padding:7px 12px;border-radius:12px;font:14px var(--font,system-ui);background:var(--input-bg,#fff);color:var(--text,#000);border:1px solid var(--border,#888);box-shadow:0 6px 20px #0003;pointer-events:none}
main.settings-content[data-os3-voice]>:not(#os3-voice-host){display:none!important}`;
    const style = document.createElement("style");
    style.textContent = CSS;
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "os3-voice-btn"; btn.innerHTML = HEADPHONES;
    btn.setAttribute("aria-label", "voice mode");
    const lab = document.createElement("div");
    lab.id = "os3-voice-label";

    const TITLES = { off: "Voice: text mode", listening: "Voice: hands-free, listening", hearing: "Hearing you…", thinking: "Transcribing…", speaking: "Speaking — talk to interrupt" };
    function setState(s, msg) {
        const t = msg || TITLES[s];
        btn.dataset.state = s;
        btn.title = t + " (click to toggle, right-click for options)";
        lab.textContent = s === "off" || s === "listening" ? "" : t;
        lab.style.display = lab.textContent ? "block" : "none";
        const r = btn.getBoundingClientRect();
        lab.style.right = Math.max(8, innerWidth - r.right) + "px";
        lab.style.bottom = innerHeight - r.top + 12 + "px";
        if (s === "error") { console.error("[voice]", t); setTimeout(() => { if (on && btn.title.startsWith(t)) setState("listening"); }, 8000); }
    }
    btn.onclick = () => (on && btn.dataset.state === "speaking" ? shutUp() : on ? stop() : start()); // tap while it talks = make it stop
    btn.oncontextmenu = (e) => { e.preventDefault(); openMenu(e.clientX, e.clientY); };

    // ---------- right-click menu (closed shadow root: page scripts can't reach in) ----------
    const SHADOW_CSS = `
.bd{position:fixed;inset:0}
.m{position:fixed;min-width:220px;padding:6px;border-radius:14px;background:var(--input-bg,#fff);color:var(--text,#000);border:1px solid var(--border,#888);box-shadow:0 12px 32px #0004;font:16px var(--font,system-ui)}
.i{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;border-radius:9px;cursor:pointer}
.i:hover{background:var(--bg-subtle,#0001)}
.i .c{margin-left:auto;color:var(--accent,#ff4612)}
hr{border:0;border-top:1px solid var(--border,#888);margin:6px 4px;opacity:.5}`;
    let menuHost;
    function closeMenu() { menuHost && menuHost.remove(); menuHost = null; removeEventListener("keydown", menuKey, true); }
    const menuKey = (e) => e.key === "Escape" && closeMenu();
    function openMenu(x, y) {
        closeMenu();
        menuHost = document.createElement("div");
        menuHost.style.cssText = "position:fixed;inset:0;z-index:1000";
        const root = menuHost.attachShadow({ mode: "closed" });
        root.innerHTML = `<style>${SHADOW_CSS}</style><div class="bd"></div><div class="m">
<button class="i" data-a="hf">Hands-free mode<span class="c">${on ? "✓" : ""}</span></button>
<button class="i" data-a="text">Text mode<span class="c">${on ? "" : "✓"}</span></button><hr>
<button class="i" data-a="set">Voice settings…</button></div>`;
        const m = root.querySelector(".m");
        root.addEventListener("click", (e) => {
            const a = e.target.closest?.("[data-a]")?.dataset.a;
            closeMenu();
            if (a === "hf" && !on) start();
            else if (a === "text" && on) stop();
            else if (a === "set") openVoiceSettings();
        });
        const bd = root.querySelector(".bd"); // listeners must live inside the closed shadow root to see real targets
        bd.addEventListener("mousedown", closeMenu);
        bd.addEventListener("contextmenu", (e) => { e.preventDefault(); closeMenu(); });
        addEventListener("keydown", menuKey, true);
        document.body.appendChild(menuHost);
        const r = m.getBoundingClientRect();
        m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + "px";
        m.style.top = Math.max(8, y - r.height - 8 > 8 ? y - r.height - 8 : y + 8) + "px"; // open upward: the button sits at the bottom
    }

    // ---------- speaking ----------
    const speaking = () => inflight > 0;
    // The mic must ignore the room while the agent talks: playing, between its sentences (next one still being
    // generated or streamed in), and a short tail after the last sound.
    const pendingReply = () => [...tracked.values()].some((t) => !t.done && Date.now() - t.born < 30000);
    const deaf = () => speaking() || pendingReply() || Date.now() - lastPlayEnd < C.tail_ms;
    const recentSpoken = () => {
        spoken = spoken.filter((s) => Date.now() - s.t < 60000);
        return spoken.map((s) => s.text).join(" ");
    };
    async function decode(u8) {
        ctxOut = ctxOut || new AudioContext();
        return ctxOut.decodeAudioData(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
    }
    const play = (buf) => new Promise((res) => {
        const s = (playing = ctxOut.createBufferSource());
        s.buffer = buf; s.connect(ctxOut.destination); s.onended = res; s.start();
    });
    function say(text) {
        const mine = epoch, pending = invoke("os3:voice:tts", text); // fetch starts now, playback stays in order
        inflight++;
        spoken.push({ t: Date.now(), text });
        chain = chain.then(async () => {
            try {
                const buf = await decode(await pending);
                if (mine !== epoch) return;
                setState("speaking");
                await play(buf);
            } catch (e) { setState("error", errText(e)); }
            finally { lastPlayEnd = Date.now(); if (--inflight === 0 && on) setState("listening"); }
        });
    }
    function shutUp() { // barge-in: drop everything queued and the rest of the current reply
        epoch++;
        try { playing && playing.stop(); } catch {}
        for (const t of tracked.values()) t.done = true;
    }

    // ---------- reading the reply as it streams ----------
    function replyText(node) {
        const body = node.querySelector(".dial-body");
        if (!body) return "";
        return [...body.children].filter((c) => c.tagName !== "PRE").map((c) => c.innerText).join("\n")
            .replace(/https?:\/\/\S+/g, "").replace(/[*_#`>|]/g, "").replace(/[ \t]+/g, " ");
    }
    const keyOf = (n) => n.closest("[data-render-id]")?.getAttribute("data-render-id") || n.getAttribute("data-render-id");
    function tick() {
        const nodes = [...document.querySelectorAll(SEL)];
        for (const n of nodes.slice(-3)) { // new messages only ever land at the end; older ones are history loading
            const k = keyOf(n);
            if (k && !seen.has(k)) { seen.add(k); tracked.set(k, { n, from: 0, last: "", changed: Date.now(), born: Date.now(), done: false }); }
        }
        for (const [k, t] of tracked) {
            if (t.done) { tracked.delete(k); continue; }
            const text = replyText(t.n);
            if (text !== t.last) { t.last = text; t.changed = Date.now(); }
            const stable = Date.now() - t.changed > 1200 && text.length > 0;
            let end;
            while (t.from < C.max_chars && (end = nextChunk(text, t.from, stable))) {
                const piece = text.slice(t.from, t.from + end).trim();
                t.from += end;
                if (piece) say(piece);
            }
            if (stable && (t.from >= text.length || t.from >= C.max_chars)) tracked.delete(k);
        }
    }

    // ---------- listening ----------
    function submit(text) {
        const ta = document.querySelector("textarea.composer-input");
        const send = document.querySelector("button.send");
        if (!ta || !send) return setState("error", "chat box not found (page layout changed?)");
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, text);
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        setTimeout(() => send.click(), 60);
    }
    async function transcribe(f32) {
        setState("thinking");
        try {
            const text = await invoke("os3:voice:stt", toWav(f32));
            // Whisper hallucinates these on near-silence
            if (text.length > 1 && !/^(thank you|thanks for watching|you)[.!]?$/i.test(text)) {
                if (isEcho(text, recentSpoken())) console.log("[voice] dropped echo of the agent's own voice:", text);
                else submit(text);
            }
        } catch (e) { return setState("error", errText(e)); }
        if (on) setState(speaking() ? "speaking" : "listening");
    }
    function finish() {
        const u = utt; utt = null; pre = []; silent = 0;
        if (u.voiced < 3) return setState(speaking() ? "speaking" : "listening"); // click/cough, not speech
        const all = new Float32Array(u.frames.length * FRAME);
        u.frames.forEach((f, i) => all.set(f, i * FRAME));
        transcribe(all);
    }
    function onFrame(f) {
        let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * f[i];
        const rms = Math.sqrt(s / f.length);
        if (!utt) {
            pre.push(f); if (pre.length > 4) pre.shift(); // keep ~250ms before the trigger so word starts aren't clipped
            if (deaf()) {
                if (!C.barge_in) { pre = []; loud = 0; return; } // half-duplex: don't listen while the agent talks
                loud = rms > C.thresh * 3 ? loud + 1 : 0; // interrupting needs sustained speech well above the echo level
                if (loud >= 3) { shutUp(); loud = 0; utt = { frames: pre.slice(-4), voiced: 3 }; silent = 0; setState("hearing"); }
                return;
            }
            loud = 0;
            if (rms > C.thresh) { utt = { frames: pre.slice(-3), voiced: 1 }; silent = 0; setState("hearing"); }
            return;
        }
        utt.frames.push(f);
        if (rms > C.thresh) { utt.voiced++; silent = 0; } else silent++;
        if (silent * FRAME_MS >= C.end_silence_ms || utt.frames.length * FRAME_MS > 60000) finish();
    }

    async function start() {
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        } catch (e) { return setState("error", "microphone blocked: " + e.message); }
        // ponytail: ScriptProcessor is deprecated but needs no extra worklet file; switch to AudioWorklet if it ever disappears
        ctxIn = new AudioContext({ sampleRate: RATE });
        const src = ctxIn.createMediaStreamSource(stream);
        proc = ctxIn.createScriptProcessor(FRAME, 1, 1);
        proc.onaudioprocess = (e) => onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
        src.connect(proc); proc.connect(ctxIn.destination);
        // replies that exist right now are history, only speak ones that arrive from here on
        seen = new Set([...document.querySelectorAll(SEL)].map(keyOf)); tracked = new Map();
        timer = setInterval(tick, 250);
        loadCfg().catch(() => {});
        on = true; setState("listening");
    }
    function stop() {
        on = false; clearInterval(timer); shutUp();
        try { proc.disconnect(); ctxIn.close(); stream.getTracks().forEach((t) => t.stop()); } catch {}
        pre = []; utt = null; setState("off");
    }

    // ---------- Settings > Voice ----------
    const NAV_ICON = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="#000" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 31v-6a16 16 0 0 1 32 0v6"/><rect x="6" y="28" width="9" height="14" rx="3"/><rect x="33" y="28" width="9" height="14" rx="3"/></svg>');
    const PAGE_CSS = `
:host{display:block;font-family:var(--font,system-ui);font-weight:200;color:var(--text,#000)}
h1{font-size:28px;font-weight:200;text-transform:lowercase;margin:0}
.sub{color:var(--text2,#666);font-size:20px;text-transform:lowercase;margin:2px 0 8px}
h2{font-size:24px;font-weight:200;margin:36px 0 2px;text-transform:lowercase}
.f{padding:16px 0 4px}
label{display:block;font-size:20px;margin-bottom:8px}
.hint{color:var(--text2,#666);font-size:15px;margin:8px 0 0;line-height:1.4}
.hint a{color:var(--accent,#ff4612)}
input,select{width:100%;max-width:560px;box-sizing:border-box;font:inherit;font-size:18px;padding:11px 20px;border-radius:24px;border:1px solid var(--input-border,#8886);background:var(--input-bg,#fff);color:var(--input-text,#000);outline:0}
input:focus,select:focus{border-color:var(--accent,#ff4612)}
input[type=range]{padding:0;border:0;background:none;accent-color:var(--accent,#ff4612);max-width:420px}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
#voice{flex:1 1 240px;width:auto;max-width:400px}
.val{font-size:16px;min-width:90px;color:var(--text2,#666)}
button{font:inherit;font-size:18px;text-transform:lowercase;padding:10px 22px;border-radius:24px;border:.7px solid var(--border,#888);background:transparent;color:var(--text,#000);cursor:var(--cursor-pointer,pointer)}
button:hover{border-color:var(--text,#000)}
button.p{background:var(--text,#000);color:var(--bg,#fff);border-color:var(--text,#000)}
.st{font-size:15px;color:var(--text2,#666)}.st.err{color:var(--red,#c1121c)}.st.ok{color:var(--green,#008754)}
table{border-collapse:collapse;font-size:16px;margin-top:8px}th,td{padding:6px 18px 6px 0;text-align:left}th{font-weight:200;color:var(--text2,#666)}
.save{margin-top:32px;display:flex;gap:16px;align-items:center}`;
    let tabOn = false, stripped = null, pageHost = null;
    const $nav = () => document.querySelector(".settings-nav");
    const $main = () => document.querySelector("main.settings-content");

    function ensureSettingsTab() {
        const ul = document.querySelector(".settings-nav ul");
        if (ul && !ul.querySelector("#os3-voice-nav")) {
            const proto = ul.querySelector("li"); // clone a native item: keeps Vue's scoped style attributes, so it looks identical
            if (proto) {
                const li = proto.cloneNode(true);
                li.id = "os3-voice-nav";
                const b = li.querySelector("button");
                b.classList.remove("active");
                b.querySelector("span").textContent = "Voice";
                const im = b.querySelector("img");
                if (im) im.src = NAV_ICON;
                ul.appendChild(li);
            }
        }
        if (tabOn && !document.querySelector(".settings-panel.open")) leaveTab(); // panel was closed while on our tab
    }
    function enterTab() {
        if (tabOn || !$main()) return;
        const prev = $nav().querySelector(".nav-item.active");
        stripped = prev; prev && prev.classList.remove("active");
        $nav().querySelector("#os3-voice-nav .nav-item").classList.add("active");
        $main().dataset.os3Voice = "1";
        pageHost = document.createElement("div");
        pageHost.id = "os3-voice-host";
        pageHost.style.cssText = "display:block;box-sizing:border-box;padding:56px 56px 64px"; // inline: the page's own CSS beats :host rules
        $main().appendChild(pageHost);
        tabOn = true;
        buildPage(pageHost.attachShadow({ mode: "closed" }));
    }
    function leaveTab(clicked) {
        tabOn = false;
        $main()?.removeAttribute("data-os3-voice");
        pageHost && pageHost.remove(); pageHost = null;
        $nav()?.querySelector("#os3-voice-nav .nav-item")?.classList.remove("active");
        // Vue still thinks `stripped` is active: if it's being clicked (no state change) or we just closed, give its class back
        if (stripped && (!clicked || clicked === stripped)) stripped.classList.add("active");
        stripped = null;
    }
    document.addEventListener("click", (e) => {
        const b = e.target.closest?.(".settings-nav .nav-item");
        if (!b) return;
        if (b.closest("#os3-voice-nav")) enterTab();
        else if (tabOn) leaveTab(b);
    }, true);

    function openVoiceSettings() {
        const go = () => setTimeout(enterTab, 150);
        if (document.querySelector(".settings-panel.open")) return go();
        document.querySelector('button.control[aria-label="Settings"]')?.click();
        go();
    }

    async function buildPage(root) {
        root.innerHTML = `<style>${PAGE_CSS}</style>
<h1>voice</h1><p class="sub">talk to OS3 and hear it answer</p>
<p class="hint">Unofficial add-on, not made by rabbit. <b>Privacy:</b> what you say is sent as audio to OpenRouter, which passes it to the speech-to-text provider (for example OpenAI or Groq). OS3's replies are sent as text to OpenRouter and the voice provider (for example Google) to be read aloud. Nothing goes to the add-on's author. Your key stays on this computer.</p>
<h2>speech</h2>
<div class="f"><label>OpenRouter API key</label><input id="key" type="password" autocomplete="off" spellcheck="false">
<p class="hint">Use a regular key (not a management key) from <a href="https://openrouter.ai/settings/keys">openrouter.ai/settings/keys</a>. It's stored only on this Mac in <code>~/.os3-voice.json</code> and never sent to the page.</p></div>
<div class="f"><label>Voice engine</label><select id="tts"></select><p class="hint" id="cost"></p></div>
<div class="f"><label>Voice</label><div class="row"><select id="voice"></select><input id="voiceText" hidden placeholder="voice name"><button id="test">test voice</button><span class="st" id="tst"></span></div></div>
<h2>listening</h2>
<div class="f"><label>Speech-to-text model</label><select id="stt"></select></div>
<div class="f"><label>Mic threshold</label><div class="row"><input id="thresh" type="range" min="0.005" max="0.08" step="0.001"><span class="val" id="threshV"></span></div><p class="hint">Lower picks up quieter speech. Raise it in a noisy room or if it keeps hearing the speakers.</p></div>
<div class="f"><label>Pause that ends your turn</label><div class="row"><input id="silence" type="range" min="400" max="2500" step="50"><span class="val" id="silenceV"></span></div></div>
<div class="f"><label>Max spoken per reply</label><div class="row"><input id="maxc" type="range" min="100" max="2000" step="50"><span class="val" id="maxcV"></span></div><p class="hint">The rest of a long reply stays on screen. Keeps cost down.</p></div>
<div class="f"><label>Talking over the agent</label><select id="barge"><option value="off">Off — it never hears itself (best on speakers)</option><option value="on">On — interrupt it by speaking (use headphones)</option></select><p class="hint">With this off, tap the headphone button while it's speaking to make it stop.</p></div>
<h2>usage</h2><div class="f" id="usage"><p class="hint">loading…</p></div>
<div class="save"><button class="p" id="save">save</button><span class="st" id="sst"></span></div>`;
        const $ = (s) => root.querySelector(s);
        const say_ = (id, msg, cls) => { const e = $(id); e.textContent = msg; e.className = "st " + (cls || ""); };
        const opt = (v, t) => Object.assign(document.createElement("option"), { value: v, textContent: t });
        let cfg = await loadCfg().catch((e) => (say_("#sst", errText(e), "err"), C));
        let models = { tts: [], stt: [], say: [] };
        $("#key").placeholder = cfg.has_key ? `saved (${cfg.key_hint}) — paste a new key to replace it` : "sk-or-…";
        const bind = (id, fmt) => { const el = $("#" + id), v = $("#" + id + "V"); const upd = () => (v.textContent = fmt(+el.value)); el.oninput = upd; return upd; };
        $("#barge").value = cfg.barge_in ? "on" : "off"; $("#thresh").value = cfg.thresh; $("#silence").value = cfg.end_silence_ms; $("#maxc").value = cfg.max_chars;
        const updT = bind("thresh", (n) => n.toFixed(3)), updS = bind("silence", (n) => n + " ms"), updM = bind("maxc", (n) => n + " chars");
        const price = (m) => (m.perM == null ? "price unknown" : m.perM === 0 ? "free" : (m.est ? "≈$" : "$") + (m.perM < 1 ? m.perM.toFixed(2) : m.perM.toFixed(0)) + "/1M chars" + (m.est ? " (est.)" : ""));
        const cost = () => {
            const m = models.tts.find((x) => x.id === $("#tts").value);
            $("#cost").textContent = $("#tts").value === "say" ? "Free, uses this Mac's built-in voices. Sounds more robotic."
                : m && m.perM ? `≈ $${(+$("#maxc").value * m.perM / 1e6).toFixed(4)} for a maximum-length spoken reply.` : "";
        };
        $("#maxc").addEventListener("input", cost);
        function fillVoices(keep) {
            const id = $("#tts").value;
            const list = id === "say" ? models.say : (models.tts.find((m) => m.id === id) || { voices: [] }).voices;
            $("#voice").replaceChildren(...list.map((v) => opt(v, v)));
            $("#voice").hidden = !list.length; $("#voiceText").hidden = !!list.length;
            if (list.includes(keep)) $("#voice").value = keep; else if (list.length) $("#voice").value = list[0];
            else $("#voiceText").value = keep || "";
            cost();
        }
        const voiceVal = () => ($("#voice").hidden ? $("#voiceText").value.trim() : $("#voice").value);
        $("#tts").onchange = () => fillVoices();
        for (const id of ["#tts", "#voice", "#stt"]) $(id).replaceChildren(opt("", "loading…"));
        try {
            models = await invoke("os3:voice:models");
        } catch (e) { say_("#sst", "couldn't load the model list: " + errText(e), "err"); }
        const ttsOpts = [...(models.say && models.say.length ? [opt("say", "macOS system voice — free")] : []), ...models.tts.map((m) => opt(m.id, `${m.name.replace(/^[^:]+: /, "")} — ${price(m)}`))];
        if (!ttsOpts.some((o) => o.value === cfg.tts_model)) ttsOpts.push(opt(cfg.tts_model, cfg.tts_model));
        $("#tts").replaceChildren(...ttsOpts); $("#tts").value = cfg.tts_model;
        const sttOpts = models.stt.map((m) => opt(m.id, m.name));
        if (!sttOpts.some((o) => o.value === cfg.stt_model)) sttOpts.push(opt(cfg.stt_model, cfg.stt_model));
        $("#stt").replaceChildren(...sttOpts); $("#stt").value = cfg.stt_model;
        fillVoices(cfg.voice); updT(); updS(); updM();

        const money = (n) => (n < 0.01 ? (n * 100).toFixed(2) + "¢" : "$" + n.toFixed(2));
        async function loadUsage() {
            try {
                const u = await invoke("os3:voice:usage");
                const row = (name, b) => `<tr><td>${name}</td><td>${b.replies}</td><td>${b.chars.toLocaleString()}</td><td>${b.heard}</td><td>≈ ${money(b.ttsCost + b.sttCost)}</td></tr>`;
                $("#usage").innerHTML = `<table><tr><th></th><th>spoken replies</th><th>characters</th><th>things you said</th><th>cost</th></tr>${row("today", u.today)}${row("all time", u.total)}</table>
<p class="hint">Costs are estimates from the model's price list${u.since ? ", counted since " + new Date(u.since).toLocaleDateString() : ""}. Only sizes are kept on this Mac (<code>~/.os3-voice-usage.jsonl</code>), never what was said.${u.key ? `<br>OpenRouter itself reports <b>$${u.key.usage.toFixed(2)}</b> spent on this key in total${u.key.limit ? " of a $" + u.key.limit + " limit" : ""} (updates a few minutes late, and includes anything else using the key). Exact per-request costs: <a href="https://openrouter.ai/activity">openrouter.ai/activity</a>.` : ""}</p>`;
            } catch (e) { $("#usage").innerHTML = `<p class="hint">couldn't load usage: ${errText(e).replace(/</g, "&lt;")}</p>`; }
        }
        loadUsage();
        $("#test").onclick = async () => {
            say_("#tst", "…");
            try {
                const u8 = await invoke("os3:voice:tts", { text: "Hi, this is how I sound. Pretty good, right?", model: $("#tts").value, voice: voiceVal(), key: $("#key").value.trim() || undefined });
                say_("#tst", "playing", "ok");
                await play(await decode(u8));
                say_("#tst", "");
                loadUsage();
            } catch (e) { say_("#tst", errText(e), "err"); }
        };
        $("#save").onclick = async () => {
            const patch = { tts_model: $("#tts").value, voice: voiceVal(), stt_model: $("#stt").value, thresh: +$("#thresh").value, end_silence_ms: +$("#silence").value, max_chars: +$("#maxc").value, barge_in: $("#barge").value === "on" };
            if ($("#key").value.trim()) patch.openrouter_key = $("#key").value.trim();
            try {
                if (patch.openrouter_key && !patch.openrouter_key.startsWith("sk-")) throw new Error("that doesn't look like an OpenRouter key (starts with sk-or-)");
                await invoke("os3:voice:setcfg", patch);
                cfg = await loadCfg();
                $("#key").value = ""; $("#key").placeholder = cfg.has_key ? `saved (${cfg.key_hint}) — paste a new key to replace it` : "sk-or-…";
                say_("#sst", "saved ✓", "ok");
            } catch (e) { say_("#sst", errText(e), "err"); }
        };
    }

    // If OS3's page changes shape, say so instead of failing silently. (The login screen has no message box: not an error.)
    function layoutCheck() {
        if (document.querySelector("textarea.composer-input") && !document.querySelector("button.send"))
            setState("error", "OS3's page has changed: the voice add-on can't find the send button. Please update the add-on.");
    }

    // ---------- mount (and keep mounted: the page re-renders) ----------
    let queued = false;
    function ensureUi() {
        const send = document.querySelector("button.send");
        if (send && send.parentElement && (btn.parentElement !== send.parentElement || btn.nextElementSibling !== send))
            send.parentElement.insertBefore(btn, send);
        if (!lab.isConnected) document.body.appendChild(lab);
        ensureSettingsTab();
    }
    function mount() {
        document.head.appendChild(style);
        setState("off");
        ensureUi();
        setTimeout(layoutCheck, 20000); setTimeout(layoutCheck, 60000);
        new MutationObserver(() => {
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => { queued = false; ensureUi(); });
        }).observe(document.documentElement, { childList: true, subtree: true });
    }
    if (document.readyState === "loading") addEventListener("DOMContentLoaded", mount);
    else mount();
})();
