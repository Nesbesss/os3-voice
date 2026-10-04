// Entry point of the OS3 Voice app. Loads the voice add-on, then rabbit OS3's own main process, untouched,
// from original.asar. Nothing inside rabbit's files is edited: the voice UI is attached as an extra preload.
// Kill switch: {"enabled": false} in ~/.os3-voice.json, or OS3_VOICE_OFF=1, starts plain rabbit OS3.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

let off = process.env.OS3_VOICE_OFF === "1";
try {
    off = off || JSON.parse(fs.readFileSync(path.join(os.homedir(), ".os3-voice.json"), "utf8")).enabled === false;
} catch {}

if (!off) {
    const { app } = require("electron");
    const pre = path.join(__dirname, "voice-preload.js");
    // runs next to rabbit's own preload in every page of the app (it only activates on os3.rabbit.tech)
    app.on("session-created", (s) => s.setPreloads([...s.getPreloads(), pre]));
    require("./voice-main.js");
}

require(path.join(process.resourcesPath, "original.asar", "lib", "main.js"));
