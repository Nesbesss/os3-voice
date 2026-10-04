// Injected into the OS3 web UI (own content world, so the page's scripts can't call into native).
// UI only: headphone button next to send (tap = hands-free on/off, long-press = menu) + Settings > Voice.
// The microphone, speech, and reading OS3's replies all happen in native code (VoiceEngine.swift).
(() => {
    if (window.__os3v) return;
    const invoke = (op, arg) => window.webkit.messageHandlers.os3.postMessage({ op, arg: arg || {} });
    const errText = (e) => String((e && e.message) || e);

    // ---------- headphone button + status ----------
    const HEADPHONES = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="7" rx="1.6"/><rect x="17" y="14" width="4" height="7" rx="1.6"/></svg>';
    const CSS = `
.os3-voice-btn{flex:none;width:calc(var(--btn,56px)*.9);height:calc(var(--btn,56px)*.9);border-radius:50%;border:1px solid var(--border,#888);background:transparent;color:var(--control-icon,#888);display:grid;place-items:center;padding:0;transition:background .15s,color .15s,border-color .15s;-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none;user-select:none;-webkit-user-select:none;touch-action:manipulation}
.os3-voice-btn svg{width:46%;height:46%;pointer-events:none}
.os3-voice-btn:not([data-state=off]) svg rect{fill:currentColor}
.os3-voice-btn:not([data-state=off]){color:#fff;border-color:transparent}
.os3-voice-btn[data-state=listening]{background:var(--green,#2e9e5b);animation:os3vpulse 2.4s ease-out infinite}
.os3-voice-btn[data-state=hearing]{background:var(--red,#d9534f)}
.os3-voice-btn[data-state=thinking]{background:var(--yellow,#c9a227)}
.os3-voice-btn[data-state=speaking]{background:var(--blue,#3b82f6)}
.os3-voice-btn[data-state=error]{background:var(--red,#8b0000);outline:2px solid var(--red,#8b0000);outline-offset:2px}
@keyframes os3vpulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--green,#2e9e5b) 55%,transparent)}70%,100%{box-shadow:0 0 0 14px transparent}}
#os3-voice-label{position:fixed;z-index:300;max-width:min(360px,80vw);padding:7px 12px;border-radius:12px;font:14px var(--font,system-ui);background:var(--input-bg,#fff);color:var(--text,#000);border:1px solid var(--border,#888);box-shadow:0 6px 20px #0003;pointer-events:none}
main.settings-content[data-os3-voice]>:not(#os3-voice-host){display:none!important}`;
    const style = document.createElement("style");
    style.textContent = CSS;
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "os3-voice-btn"; btn.innerHTML = HEADPHONES;
    btn.setAttribute("aria-label", "voice mode");
    const lab = document.createElement("div");
    lab.id = "os3-voice-label";

    let phase = "off";
    const isOn = () => phase !== "off";
    const TITLES = { off: "Voice: text mode", listening: "Hands-free: listening", hearing: "Hearing you…", thinking: "Thinking…", speaking: "Speaking: tap to stop" };
    function setState(s, detail) {
        phase = s;
        btn.dataset.state = s;
        const t = s === "error" ? detail || "Problem" : s === "thinking" && detail ? detail : TITLES[s];
        btn.title = t;
        lab.textContent = s === "off" || s === "listening" ? "" : t;
        lab.style.display = lab.textContent ? "block" : "none";
        const r = btn.getBoundingClientRect();
        lab.style.right = Math.max(8, innerWidth - r.right) + "px";
        lab.style.bottom = innerHeight - r.top + 12 + "px";
    }
    window.__os3v = { state: setState };

    // tap = toggle (or stop talking), long-press = menu
    let pressTimer = null, longFired = false;
    btn.addEventListener("pointerdown", (e) => {
        longFired = false;
        clearTimeout(pressTimer);
        pressTimer = setTimeout(() => { longFired = true; navigator.vibrate && navigator.vibrate(10); openMenu(e.clientX, e.clientY); }, 500);
    });
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) btn.addEventListener(ev, () => clearTimeout(pressTimer));
    btn.addEventListener("click", (e) => {
        if (longFired) { longFired = false; e.preventDefault(); return; }
        sendSession();
        invoke("toggle").catch((err) => setState("error", errText(err)));
    });
    btn.addEventListener("contextmenu", (e) => { e.preventDefault(); openMenu(e.clientX, e.clientY); });

    // the web UI keeps its conversation id in localStorage; native joins the same conversation with it
    function sendSession() {
        try {
            const id = localStorage.getItem("rabbit-hole-session-id");
            if (id) invoke("session", { id }).catch(() => {});
        } catch {}
    }

    // ---------- menu (closed shadow root: page scripts can't reach in) ----------
    const SHADOW_CSS = `
.bd{position:fixed;inset:0}
.m{position:fixed;min-width:230px;padding:6px;border-radius:16px;background:var(--input-bg,#fff);color:var(--text,#000);border:1px solid var(--border,#888);box-shadow:0 12px 32px #0004;font:17px var(--font,system-ui)}
.i{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;padding:13px 14px;border-radius:10px}
.i:active{background:var(--bg-subtle,#0001)}
.i .c{margin-left:auto;color:var(--accent,#ff4612)}
hr{border:0;border-top:1px solid var(--border,#888);margin:6px 4px;opacity:.5}`;
    let menuHost;
    function closeMenu() { menuHost && menuHost.remove(); menuHost = null; }
    function openMenu(x, y) {
        closeMenu();
        menuHost = document.createElement("div");
        menuHost.style.cssText = "position:fixed;inset:0;z-index:1000";
        const root = menuHost.attachShadow({ mode: "closed" });
        const on = isOn();
        root.innerHTML = `<style>${SHADOW_CSS}</style><div class="bd"></div><div class="m">
<button class="i" data-a="hf">Hands-free mode<span class="c">${on ? "✓" : ""}</span></button>
<button class="i" data-a="text">Text mode<span class="c">${on ? "" : "✓"}</span></button><hr>
<button class="i" data-a="set">Voice settings…</button></div>`;
        const m = root.querySelector(".m");
        root.addEventListener("click", (e) => {
            const a = e.target.closest && e.target.closest("[data-a]") && e.target.closest("[data-a]").dataset.a;
            closeMenu();
            if (a === "hf" && !isOn()) { sendSession(); invoke("start").catch((err) => setState("error", errText(err))); }
            else if (a === "text" && isOn()) invoke("stop").catch(() => {});
            else if (a === "set") openVoiceSettings();
        });
        root.querySelector(".bd").addEventListener("pointerdown", closeMenu);
        document.body.appendChild(menuHost);
        const r = m.getBoundingClientRect();
        m.style.left = Math.max(8, Math.min(x - r.width / 2, innerWidth - r.width - 8)) + "px";
        m.style.top = Math.max(8, y - r.height - 16) + "px"; // opens upward: the button sits at the bottom
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
button{font:inherit;font-size:18px;text-transform:lowercase;padding:10px 22px;border-radius:24px;border:.7px solid var(--border,#888);background:transparent;color:var(--text,#000)}
button.p{background:var(--text,#000);color:var(--bg,#fff);border-color:var(--text,#000)}
.st{font-size:15px;color:var(--text2,#666)}.st.err{color:var(--red,#c1121c)}.st.ok{color:var(--green,#008754)}
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
        $main() && $main().removeAttribute("data-os3-voice");
        pageHost && pageHost.remove(); pageHost = null;
        const mine = $nav() && $nav().querySelector("#os3-voice-nav .nav-item");
        mine && mine.classList.remove("active");
        // Vue still thinks `stripped` is active: if it's being clicked (no state change) or we just closed, give its class back
        if (stripped && (!clicked || clicked === stripped)) stripped.classList.add("active");
        stripped = null;
    }
    document.addEventListener("click", (e) => {
        const b = e.target.closest && e.target.closest(".settings-nav .nav-item");
        if (!b) return;
        if (b.closest("#os3-voice-nav")) enterTab();
        else if (tabOn) leaveTab(b);
    }, true);

    function openVoiceSettings() {
        const go = () => setTimeout(enterTab, 200);
        if (document.querySelector(".settings-panel.open")) return go();
        const gear = document.querySelector('button.control[aria-label="Settings"]');
        gear && gear.click();
        go();
    }

    async function buildPage(root) {
        root.innerHTML = `<style>${PAGE_CSS}</style>
<h1>voice</h1><p class="sub">talk to OS3 and hear it answer</p>
<h2>speech</h2>
<div class="f"><label>OpenRouter API key</label><input id="key" type="password" autocomplete="off" spellcheck="false">
<p class="hint">Use a regular key (not a management key) from <a href="https://openrouter.ai/settings/keys">openrouter.ai/settings/keys</a>. It's stored in this iPhone's Keychain and never sent to the page.</p></div>
<div class="f"><label>Voice engine</label><select id="tts"></select><p class="hint" id="cost"></p></div>
<div class="f"><label>Voice</label><div class="row"><select id="voice"></select><input id="voiceText" hidden placeholder="voice name"><button id="test">test voice</button><span class="st" id="tst"></span></div></div>
<h2>listening</h2>
<div class="f"><label>Speech-to-text model</label><select id="stt"></select></div>
<div class="f"><label>Mic threshold</label><div class="row"><input id="thresh" type="range" min="0.005" max="0.08" step="0.001"><span class="val" id="threshV"></span></div><p class="hint">Lower picks up quieter speech. Raise it in a noisy room or if it keeps hearing the speaker.</p></div>
<div class="f"><label>Pause that ends your turn</label><div class="row"><input id="silence" type="range" min="400" max="2500" step="50"><span class="val" id="silenceV"></span></div></div>
<div class="f"><label>Max spoken per reply</label><div class="row"><input id="maxc" type="range" min="100" max="2000" step="50"><span class="val" id="maxcV"></span></div><p class="hint">The rest of a long reply stays on screen. Keeps cost down.</p></div>
<div class="f"><label>Talking over the agent</label><select id="barge"><option value="off">Off — it never hears itself (best on speaker)</option><option value="on">On — interrupt it by speaking (best with headphones)</option></select><p class="hint">With this off, tap the headphone button while it's speaking to make it stop.</p></div>
<div class="save"><button class="p" id="save">save</button><span class="st" id="sst"></span></div>`;
        const $ = (s) => root.querySelector(s);
        const say_ = (id, msg, cls) => { const e = $(id); e.textContent = msg; e.className = "st " + (cls || ""); };
        const opt = (v, t) => Object.assign(document.createElement("option"), { value: v, textContent: t });
        let cfg = await invoke("cfg").catch((e) => (say_("#sst", errText(e), "err"), {}));
        let models = { tts: [], stt: [] };
        const keyHint = () => ($("#key").placeholder = cfg.has_key ? `saved (${cfg.key_hint}) — paste a new key to replace it` : "sk-or-…");
        keyHint();
        const bind = (id, fmt) => { const el = $("#" + id), v = $("#" + id + "V"); const upd = () => (v.textContent = fmt(+el.value)); el.oninput = upd; return upd; };
        $("#barge").value = cfg.barge_in ? "on" : "off"; $("#thresh").value = cfg.thresh; $("#silence").value = cfg.end_silence_ms; $("#maxc").value = cfg.max_chars;
        const updT = bind("thresh", (n) => n.toFixed(3)), updS = bind("silence", (n) => n + " ms"), updM = bind("maxc", (n) => n + " chars");
        const price = (m) => (m.perM == null ? "price unknown" : m.perM === 0 ? "free" : (m.est ? "≈$" : "$") + (m.perM < 1 ? m.perM.toFixed(2) : m.perM.toFixed(0)) + "/1M chars" + (m.est ? " (est.)" : ""));
        const cost = () => {
            const m = models.tts.find((x) => x.id === $("#tts").value);
            $("#cost").textContent = m && m.perM ? `≈ $${(+$("#maxc").value * m.perM / 1e6).toFixed(4)} for a maximum-length spoken reply.` : "";
        };
        $("#maxc").addEventListener("input", cost);
        function fillVoices(keep) {
            const m = models.tts.find((x) => x.id === $("#tts").value);
            const list = m ? m.voices : [];
            $("#voice").replaceChildren(...list.map((v) => opt(v, v)));
            $("#voice").hidden = !list.length; $("#voiceText").hidden = !!list.length;
            if (list.includes(keep)) $("#voice").value = keep; else if (list.length) $("#voice").value = list[0];
            else $("#voiceText").value = keep || "";
            cost();
        }
        const voiceVal = () => ($("#voice").hidden ? $("#voiceText").value.trim() : $("#voice").value);
        $("#tts").onchange = () => fillVoices();
        for (const id of ["#tts", "#voice", "#stt"]) $(id).replaceChildren(opt("", "loading…"));
        try { models = await invoke("models"); } catch (e) { say_("#sst", "couldn't load the model list: " + errText(e), "err"); }
        const ttsOpts = models.tts.map((m) => opt(m.id, `${m.name.replace(/^[^:]+: /, "")} — ${price(m)}`));
        if (!ttsOpts.some((o) => o.value === cfg.tts_model)) ttsOpts.push(opt(cfg.tts_model, cfg.tts_model));
        $("#tts").replaceChildren(...ttsOpts); $("#tts").value = cfg.tts_model;
        const sttOpts = models.stt.map((m) => opt(m.id, m.name));
        if (!sttOpts.some((o) => o.value === cfg.stt_model)) sttOpts.push(opt(cfg.stt_model, cfg.stt_model));
        $("#stt").replaceChildren(...sttOpts); $("#stt").value = cfg.stt_model;
        fillVoices(cfg.voice); updT(); updS(); updM();

        $("#test").onclick = async () => {
            say_("#tst", "…");
            try {
                say_("#tst", "playing", "ok");
                await invoke("tts", { text: "Hi, this is how I sound. Pretty good, right?", model: $("#tts").value, voice: voiceVal(), key: $("#key").value.trim() || undefined });
                say_("#tst", "");
            } catch (e) { say_("#tst", errText(e), "err"); }
        };
        $("#save").onclick = async () => {
            const patch = { tts_model: $("#tts").value, voice: voiceVal(), stt_model: $("#stt").value, thresh: +$("#thresh").value, end_silence_ms: +$("#silence").value, max_chars: +$("#maxc").value, barge_in: $("#barge").value === "on" };
            const k = $("#key").value.trim();
            try {
                if (k && !k.startsWith("sk-")) throw new Error("that doesn't look like an OpenRouter key (starts with sk-or-)");
                if (k) patch.openrouter_key = k;
                await invoke("setcfg", patch);
                cfg = await invoke("cfg");
                $("#key").value = ""; keyHint();
                say_("#sst", "saved ✓", "ok");
            } catch (e) { say_("#sst", errText(e), "err"); }
        };
    }

    // native paints the safe-area bars (notch / home bar) with the page's own background, light or dark
    let lastBg = "";
    function reportBg() {
        for (const el of [document.body, document.documentElement]) {
            const m = getComputedStyle(el).backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
            if (m && (m[4] === undefined || +m[4] > 0)) {
                const rgb = [+m[1], +m[2], +m[3]], key = rgb.join();
                if (key !== lastBg) { lastBg = key; invoke("bg", { rgb }).catch(() => {}); }
                return;
            }
        }
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
        new MutationObserver(() => {
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => { queued = false; ensureUi(); });
        }).observe(document.documentElement, { childList: true, subtree: true });
        sendSession();
        setInterval(sendSession, 20000);
        reportBg();
        setTimeout(reportBg, 800); setTimeout(reportBg, 2500);   // after the page has applied its theme
        new MutationObserver(reportBg).observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
        invoke("cfg").then((c) => c && c.phase && setState(c.phase)).catch(() => {});
    }
    if (document.readyState === "loading") addEventListener("DOMContentLoaded", mount);
    else mount();
})();
