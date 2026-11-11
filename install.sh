#!/bin/sh
# beam installer for macOS:  curl -fsSL https://raw.githubusercontent.com/DaniilPak/beam/main/install.sh | sh
set -e
case "$(uname -m)" in arm64|aarch64) F=beam-mac-arm64 ;; *) F=beam-mac-x64 ;; esac
D="$HOME/.beam/dist"; mkdir -p "$D"
echo "Downloading beam..."
curl -fL --progress-bar "https://github.com/DaniilPak/beam/releases/latest/download/$F" -o "$D/$F"
chmod +x "$D/$F"
xattr -d com.apple.quarantine "$D/$F" 2>/dev/null || true
codesign -v "$D/$F" 2>/dev/null || codesign --force --sign - "$D/$F"
"$D/$F" install
