# OS3 Voice

Talk to your rabbit OS3 agent and hear it answer.

A small add-on for the rabbit OS3 desktop app. Tap the headphone button next to **send**, then just talk. What you say is transcribed and sent to OS3 like a typed message, and OS3's **conversation model's** replies are read aloud as they stream in, sentence by sentence. Worker (sub-agent) output is not read out.

- **Hands-free.** Voice detection ends your turn when you pause. No pushing buttons.
- **Right-click the button** for *Hands-free mode* / *Text mode* / *Voice settings*.
- **Settings → Voice** inside OS3: API key, voice engine (with prices), voice, test button, mic sensitivity, usage and cost.
- **Echo-proof by default.** The mic is ignored while the agent talks, and anything that is just the agent's own words coming back is dropped. Turn on *Talking over the agent* if you wear headphones.
- **Bring your own key.** Speech goes through [OpenRouter](https://openrouter.ai) with your own key. Default voice: Gemini Flash-Lite, *Zephyr*.

> **Unofficial.** This project is not made by, affiliated with or endorsed by rabbit. It contains none of rabbit's code. See [How it works](#how-it-works).

## Install (macOS)

You need rabbit OS3 installed in `/Applications` and an OpenRouter key.

```sh
curl -fsSL https://raw.githubusercontent.com/Nesbesss/os3-voice/main/install.sh | bash
```

Or from a checkout: `./install.sh`. Add `--auto` to rebuild automatically after rabbit OS3 updates.

This creates **OS3 Voice** in `~/Applications`, built from your own copy of rabbit OS3. Open it, log in to OS3 as usual, go to **Settings → Voice**, paste a key from [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) (a regular key, not a management key) and save. macOS asks for microphone access the first time you tap the button.

Your original rabbit OS3 is never modified. Both share the same login, but only run one at a time.

## Cost

Speech output is almost all of the cost. Measured with the default voice (Gemini 3.8 Flash-Lite):

| Spoken reply | Cost |
|---|---|
| short (~150 characters) | ≈ 0.2¢ |
| medium (~360 characters) | ≈ 0.4¢ |
| long (~700 characters, the default cap) | ≈ 0.8¢ |

Transcribing your voice is about 0.05¢ per minute. Lower **Max spoken per reply** in Settings → Voice to spend less (the rest of the reply stays on screen). **Settings → Voice → usage** shows your replies, characters and estimated cost, plus OpenRouter's own total for your key. Google has announced that Gemini prices double on 1 January 2027.

Cheaper voices exist (Kokoro is about 18× cheaper) but sound noticeably more robotic. The Voice engine list in settings shows live prices.

## Privacy

- What you say is sent as **audio** to OpenRouter, which passes it to the speech-to-text provider you chose (for example OpenAI or Groq).
- OS3's replies are sent as **text** to OpenRouter and the voice provider (for example Google) to be read aloud.
- Nothing is sent to this project or its author. There is no server.
- Your key is stored on your computer in `~/.os3-voice.json` (readable only by you) and is never given to the web page.
- The usage log `~/.os3-voice-usage.jsonl` records only sizes (characters, seconds, cost), never what was said.

## When rabbit updates OS3

OS3 Voice is a copy, so it does not update itself. After a rabbit OS3 update, run the installer again, or install once with `--auto` and it rebuilds on its own (checked daily and whenever rabbit OS3 changes).

The add-on attaches to specific parts of OS3's page (the message box, the send button, the settings tabs). If a rabbit update changes those, the headphone button shows *"OS3's page has changed…"* instead of failing silently. Please [open an issue](../../issues).

## Turn it off / uninstall

- **Run plain OS3 without voice:** set `"enabled": false` in `~/.os3-voice.json`, or start with `OS3_VOICE_OFF=1`.
- **Uninstall:** `~/.os3-voice/install.sh uninstall` (add `--purge` to also delete your key, settings and usage log).

## Tips

- **Speakers vs headphones.** On speakers, leave *Talking over the agent* off; tap the headphone button while it speaks to stop it. With headphones, turn it on to interrupt by speaking.
- **It misses you or hears too much?** Adjust *Mic threshold* in settings.
- **Free voice.** Choose *macOS system voice* as the engine: free, but robotic.

## Windows (experimental)

`windows/install.ps1` does the same thing on Windows. **It has not been tried on a real Windows PC yet**, so expect rough edges and please report what happens. The free macOS voice is not available there.

## How it works

The installer copies *your* installed rabbit OS3, renames rabbit's code (`app.asar` → `original.asar`, otherwise unchanged) and puts a small starter next to it. The starter loads this add-on, then runs rabbit's own main program untouched. The voice button is injected into the page as an extra script that only runs on `os3.rabbit.tech`. Microphone capture and speech-to-text/text-to-speech calls happen in the app's main process, not in the page. The copy is signed ad hoc on your Mac with the microphone permission, because rabbit's signature no longer matches.

```
addon/boot.js           starts the add-on, then rabbit's own app
addon/voice-main.js     OpenRouter calls, settings, usage log
addon/voice-preload.js  headphone button, voice detection, speaking, Settings → Voice
install.sh              builds OS3 Voice.app from your rabbit OS3 (macOS)
windows/install.ps1     the same for Windows (experimental)
ios/                    a personal iPhone version, see below
```

Develop: `node test.js` runs the self-checks for the sentence splitting, echo filter, audio encoding and usage totals.

## iPhone

`ios/` is an iPhone app (the OS3 web page plus native hands-free voice, a Live Activity and a Home Screen shortcut). It is a personal project: build it yourself with Xcode (`xcodegen generate`, set your own team in `project.yml`). It is not documented or supported, and it cannot be distributed on the App Store as it wraps rabbit's service.

## License

MIT, see [LICENSE](LICENSE). That covers this repository only; rabbit OS3 belongs to rabbit.
