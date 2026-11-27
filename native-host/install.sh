#!/bin/sh
# Installs Tab Desk's Claude Code helper (a Chrome native messaging host) for the current user on
# macOS or Linux. It lets Tab Desk run `claude -p` with your existing Claude Code sign-in.
#
#   ./native-host/install.sh <extension-id> [<another-extension-id> ...]
#   ./native-host/install.sh --uninstall
#
# The extension ID is shown in Tab Desk under Settings > General > Cloud > Claude Code (local),
# and on chrome://extensions with Developer mode on. Needs Node.js 18+ and Claude Code.
set -eu

NAME="com.tabdesk.claude_code"
HERE=$(cd "$(dirname "$0")" && pwd)

case "$(uname -s)" in
  Darwin)
    DEST="$HOME/Library/Application Support/Tab Desk/native-host"
    BASE="$HOME/Library/Application Support"
    BROWSERS="Google/Chrome|Google/Chrome Beta|Google/Chrome Canary|Chromium|Microsoft Edge|BraveSoftware/Brave-Browser|Vivaldi|Arc/User Data"
    ;;
  Linux)
    DEST="${XDG_DATA_HOME:-$HOME/.local/share}/tab-desk/native-host"
    BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
    BROWSERS="google-chrome|google-chrome-beta|google-chrome-unstable|chromium|microsoft-edge|BraveSoftware/Brave-Browser|vivaldi"
    ;;
  *)
    echo "This script is for macOS and Linux. On Windows, run native-host\\install.ps1 in PowerShell." >&2
    exit 1
    ;;
esac
# Chrome's own folder always gets the manifest; other Chromium browsers only when they're installed.
CHROME_DIR="$BASE/$( [ "$(uname -s)" = Darwin ] && echo "Google/Chrome" || echo "google-chrome" )"

each_browser() { # calls "$1" with each browser profile root that should get the manifest
  OLDIFS=$IFS; IFS='|'
  for b in $BROWSERS; do
    IFS=$OLDIFS
    if [ "$BASE/$b" = "$CHROME_DIR" ] || [ -d "$BASE/$b" ]; then "$1" "$BASE/$b"; fi
    IFS='|'
  done
  IFS=$OLDIFS
}

if [ "${1:-}" = "--uninstall" ]; then
  remove() { rm -f "$1/NativeMessagingHosts/$NAME.json"; }
  each_browser remove
  rm -rf "$DEST"
  echo "Removed Tab Desk's Claude Code helper."
  exit 0
fi

if [ $# -eq 0 ]; then
  echo "Usage: $0 <extension-id> [<another-extension-id> ...]" >&2
  echo "Find the ID in Tab Desk: Settings > General > Cloud > Claude Code (local)." >&2
  exit 1
fi
ORIGINS=""
for id in "$@"; do
  if ! printf '%s' "$id" | grep -Eq '^[a-p]{32}$'; then
    echo "“$id” doesn’t look like a Chrome extension ID (32 letters a–p)." >&2
    exit 1
  fi
  ORIGINS="$ORIGINS${ORIGINS:+, }\"chrome-extension://$id/\""
done

NODE=$(command -v node || true)
if [ -z "$NODE" ]; then
  echo "Node.js 18 or later is needed for the helper, and \`node\` isn’t on your PATH. Install it from https://nodejs.org and run this again." >&2
  exit 1
fi
NODE_MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "The helper needs Node.js 18 or later; $NODE is $("$NODE" --version)." >&2
  exit 1
fi

CLAUDE=$(command -v claude || true)
for p in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
  [ -n "$CLAUDE" ] && break
  [ -x "$p" ] && CLAUDE="$p"
done
if [ -z "$CLAUDE" ]; then
  echo "Warning: Claude Code (\`claude\`) wasn’t found. Install it and sign in, then run this again so the helper knows where it is." >&2
fi

mkdir -p "$DEST"
cp "$HERE/tab-desk-claude-host.mjs" "$DEST/tab-desk-claude-host.mjs"
"$NODE" -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ claude: process.argv[2] || null }, null, 2) + "\n")' "$DEST/config.json" "$CLAUDE"
# Chrome starts the host with a short PATH, so the wrapper names node by its full path.
cat > "$DEST/tab-desk-claude-host" <<WRAP
#!/bin/sh
exec "$NODE" "$DEST/tab-desk-claude-host.mjs" "\$@"
WRAP
chmod 755 "$DEST/tab-desk-claude-host"

MANIFEST=$(cat <<JSON
{
  "name": "$NAME",
  "description": "Tab Desk: runs Claude Code (claude -p) for AI summaries",
  "path": "$DEST/tab-desk-claude-host",
  "type": "stdio",
  "allowed_origins": [$ORIGINS]
}
JSON
)
INSTALLED=""
put() {
  mkdir -p "$1/NativeMessagingHosts"
  printf '%s\n' "$MANIFEST" > "$1/NativeMessagingHosts/$NAME.json"
  INSTALLED="$INSTALLED\n  $1/NativeMessagingHosts/$NAME.json"
}
each_browser put

echo "Installed Tab Desk's Claude Code helper."
echo "  Helper:   $DEST"
echo "  Node:     $NODE"
echo "  Claude:   ${CLAUDE:-not found}"
printf "  Manifest:%b\n" "$INSTALLED"
echo "Now press “Test connection” in Tab Desk’s Settings."
