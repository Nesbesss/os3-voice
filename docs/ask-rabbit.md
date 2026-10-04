# Message to rabbit (draft)

OS3 Voice modifies a *copy* of the rabbit OS3 desktop app on the user's own machine, so it is worth asking rabbit before promoting it. A draft you can send:

---

Hi rabbit team,

I love OS3 but I hate typing, so I built a voice mode for the desktop app: a headphone button next to send (hands-free; it hears you, sends your words as a normal chat message, and reads the conversation model's replies aloud as they stream in, never the workers' output). It uses OpenRouter for speech with the user's own key, and has a settings page, usage tracking and echo protection.

It works as an unofficial add-on: the installer copies the user's own OS3 app and loads a small extra script next to rabbit's unchanged code. I do not distribute any of rabbit's files. Source: https://github.com/Nesbesss/os3-voice

Two questions:
1. Are you fine with people using an add-on like this? If not, I will take it down.
2. Would you want this built into OS3 natively? I'm happy to hand over the design and code. The page parts it relies on are `textarea.composer-input`, `button.send`, `.dial-msg[data-structure-key="text|butler"]` and the `.settings-nav` list, so a heads-up before you redesign those would help.

Thanks!
