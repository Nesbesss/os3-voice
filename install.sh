#!/bin/bash
# OS3 Voice add-on for macOS.
# Builds "OS3 Voice.app" from YOUR installed rabbit OS3. Nothing of rabbit's is downloaded or redistributed:
# the copy is made on your Mac and rabbit's own files are left untouched inside it.
#
#   curl -fsSL https://raw.githubusercontent.com/Nesbesss/os3-voice/main/install.sh | bash
#   ... | bash -s -- --auto     also rebuild automatically after rabbit OS3 updates
#   ./install.sh uninstall      remove everything (add --purge to also delete your key, settings and usage log)
set -euo pipefail

REPO="${OS3_VOICE_REPO:-Nesbesss/os3-voice}"
BRANCH="${OS3_VOICE_BRANCH:-main}"
SRC="${OS3_SRC:-/Applications/rabbit OS3.app}"
DST="$HOME/Applications/OS3 Voice.app"
STORE="$HOME/.os3-voice"                      # a copy of the add-on, so auto-update works offline
AGENT="$HOME/Library/LaunchAgents/com.os3voice.update.plist"
TESTED="0.1.0"                                # rabbit OS3 versions this was tried against

AUTO=0; QUIET=0; PURGE=0; CMD=install
for a in "$@"; do
  case "$a" in
    --auto) AUTO=1 ;; --quiet) QUIET=1 ;; --purge) PURGE=1 ;; uninstall) CMD=uninstall ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done
say() { [ "$QUIET" = 1 ] || echo "$@"; }
running() { pgrep -f "$DST/Contents/MacOS" >/dev/null 2>&1; }

if [ "$CMD" = uninstall ]; then
  launchctl bootout "gui/$(id -u)" "$AGENT" 2>/dev/null || true
  rm -f "$AGENT"
  running && { osascript -e 'tell application "OS3 Voice" to quit' 2>/dev/null || true; sleep 2; }
  rm -rf "$DST" "$STORE"
  if [ "$PURGE" = 1 ]; then rm -f "$HOME/.os3-voice.json" "$HOME/.os3-voice-usage.jsonl"; echo "Removed OS3 Voice, your key, settings and usage log."
  else echo "Removed OS3 Voice. Your key and settings are kept in ~/.os3-voice.json (run again with --purge to delete them)."; fi
  exit 0
fi

[ "$(uname)" = Darwin ] || { echo "This installer is for macOS. On Windows use windows/install.ps1." >&2; exit 1; }
[ -d "$SRC" ] || { echo "Can't find $SRC. Install rabbit OS3 first (or set OS3_SRC=/path/to/rabbit OS3.app)." >&2; exit 1; }

VER="$(plutil -extract CFBundleShortVersionString raw "$SRC/Contents/Info.plist" 2>/dev/null || echo unknown)"
# Auto mode: do nothing unless rabbit OS3 changed since the last build, and never interrupt a running voice app.
if [ "$QUIET" = 1 ] && [ -d "$DST" ] && [ "$(cat "$STORE/built-from" 2>/dev/null)" = "$VER" ]; then exit 0; fi
if [ "$QUIET" = 1 ] && running; then exit 0; fi

# Get the add-on files: next to this script if we're in a checkout, otherwise download the repo.
HERE=""   # empty when piped from curl (there is no script file then)
[ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ] && HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
if [ -f "$HERE/addon/boot.js" ]; then
  ADDON="$HERE/addon"
else
  say "Downloading the add-on from github.com/$REPO ..."
  curl -fsSL "${OS3_VOICE_TARBALL:-https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz}" | tar -xz -C "$T" --strip-components=1
  ADDON="$T/addon"
fi
[ -f "$ADDON/boot.js" ] || { echo "Add-on files not found." >&2; exit 1; }

if [ "$VER" != "$TESTED" ]; then
  say "Note: you have rabbit OS3 $VER; this add-on was tried against $TESTED. It should still work;"
  say "      if OS3's page has changed, the voice button shows a message instead of failing silently."
fi

pkill -f "rabbit OS3 Voice.app/Contents/MacOS" 2>/dev/null || true   # an earlier hand-made build shares the same login folder
running && { say "Closing the running OS3 Voice ..."; osascript -e 'tell application "OS3 Voice" to quit' 2>/dev/null || true; sleep 2; pkill -f "$DST/Contents/MacOS" 2>/dev/null || true; }

say "Building OS3 Voice from your rabbit OS3 $VER ..."
rm -rf "$DST"; mkdir -p "$HOME/Applications"
ditto "$SRC" "$DST"
R="$DST/Contents/Resources"
# rabbit's code stays exactly as shipped, just renamed; our wrapper app/ folder starts first and then runs it
mv "$R/app.asar" "$R/original.asar"
[ -e "$R/app.asar.unpacked" ] && mv "$R/app.asar.unpacked" "$R/original.asar.unpacked"
mkdir -p "$R/app"
cp "$ADDON/boot.js" "$ADDON/voice-main.js" "$ADDON/voice-preload.js" "$R/app/"
printf '{"name":"os3-voice","productName":"OS3 Voice","version":"%s","main":"boot.js"}\n' "$VER" > "$R/app/package.json"

# its own identity, so it never fights with the original app (permissions, Launch Services)
P="$DST/Contents/Info.plist"
plutil -replace CFBundleIdentifier -string "com.os3voice.addon" "$P"
# (CFBundleName stays: Electron finds its helper apps by that name)
plutil -replace CFBundleDisplayName -string "OS3 Voice" "$P"
# rabbit's signature no longer matches the copy: sign it ad hoc, with the microphone entitlement
codesign --force --deep --sign - --entitlements "$ADDON/entitlements.plist" "$DST" >/dev/null 2>&1
codesign --verify --deep "$DST" || { echo "Signing failed." >&2; exit 1; }

mkdir -p "$STORE"; rm -rf "$STORE/addon"; cp -R "$ADDON" "$STORE/addon"
[ -f "$HERE/install.sh" ] && cp "$HERE/install.sh" "$STORE/install.sh" || cp "$T/install.sh" "$STORE/install.sh" 2>/dev/null || true
echo "$VER" > "$STORE/built-from"

if [ "$AUTO" = 1 ]; then
  mkdir -p "$(dirname "$AGENT")"
  cat > "$AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.os3voice.update</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$STORE/install.sh</string><string>--quiet</string></array>
  <key>EnvironmentVariables</key><dict><key>OS3_SRC</key><string>$SRC</string></dict>
  <key>WatchPaths</key><array><string>$SRC/Contents/Info.plist</string></array>
  <key>StartInterval</key><integer>86400</integer>
  <key>RunAtLoad</key><false/>
</dict></plist>
EOF
  plutil -lint "$AGENT" >/dev/null
  launchctl bootout "gui/$(id -u)" "$AGENT" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENT"
  say "Auto-rebuild is on: OS3 Voice is rebuilt after rabbit OS3 updates (checked daily and when it changes)."
fi

say ""
say "Done: $DST"
say "Open it, log in to OS3 as usual, then Settings > Voice: paste an OpenRouter key (openrouter.ai/settings/keys)."
say "macOS will ask for microphone access the first time you tap the headphone button."
say "Privacy: speech you say is sent as audio to OpenRouter and its speech providers; see the README."
[ "$AUTO" = 1 ] || say "Tip: after a rabbit OS3 update, run this installer again (or install with --auto)."
