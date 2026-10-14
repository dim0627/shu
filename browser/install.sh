#!/bin/sh
# Registers browser/host.py with Google Chrome, so that the SHU extension may start it.
#
#   sh browser/install.sh <extension ID>
#
# The ID is on chrome://extensions once browser/chrome is loaded unpacked. It stays
# the same while the folder does not move; after a move, load it again and rerun this.
# Run it from a shell where `shu` works: Chrome started from the Dock gets neither this
# shell's PATH nor its SHU_HOME, so both are recorded for the host.
#
#   SHU_CHROME_HOSTS_DIR   where the browser looks for host manifests (default: Google
#                          Chrome's, per OS; set it for another Chromium browser)
set -eu

NAME="io.github.dim0627.shu"
ID="${1:-}"

# Listed, not a range: in a UTF-8 locale [a-p] also matches uppercase letters
case "$ID" in
  "" | *[!abcdefghijklmnop]*)
    echo "usage: sh browser/install.sh <extension ID: 32 letters a-p, from chrome://extensions>" >&2
    exit 1
    ;;
esac
if [ "${#ID}" -ne 32 ]; then
  echo "install.sh: an extension ID is 32 letters long: $ID" >&2
  exit 1
fi

if ! SHU="$(command -v shu)"; then
  echo "install.sh: shu is not on PATH. Install it first: curl -fsSL https://raw.githubusercontent.com/dim0627/shu/main/scripts/install.sh | sh" >&2
  exit 1
fi
HOST="$(cd "$(dirname "$0")" && pwd)/host.py"
SHU_HOME_VALUE="${SHU_HOME:-}"
case "$SHU_HOME_VALUE" in
  "" | /*) ;;
  *)
    echo "install.sh: SHU_HOME must be an absolute path for the host: $SHU_HOME_VALUE" >&2
    exit 1
    ;;
esac
for value in "$HOST" "$SHU" "$SHU_HOME_VALUE"; do
  case "$value" in
    *\"* | *\\*)
      echo "install.sh: a path cannot hold \" or \\ (it goes into JSON as is): $value" >&2
      exit 1
      ;;
  esac
done

if [ -n "${SHU_CHROME_HOSTS_DIR:-}" ]; then
  DIR="$SHU_CHROME_HOSTS_DIR"
else
  case "$(uname -s)" in
    Darwin) DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" ;;
    Linux) DIR="${XDG_CONFIG_HOME:-$HOME/.config}/google-chrome/NativeMessagingHosts" ;;
    *)
      echo "install.sh: unsupported OS: $(uname -s)" >&2
      exit 1
      ;;
  esac
fi
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/shu/browser-host.json"

if [ -n "$SHU_HOME_VALUE" ]; then
  SHU_HOME_JSON="\"$SHU_HOME_VALUE\""
else
  SHU_HOME_JSON="null"
fi

chmod +x "$HOST"
mkdir -p "$(dirname "$CONFIG")" "$DIR"
cat >"$CONFIG" <<EOF
{"shu": "$SHU", "shu_home": $SHU_HOME_JSON}
EOF
cat >"$DIR/$NAME.json" <<EOF
{
  "name": "$NAME",
  "description": "SHU task lookup for the SHU extension",
  "path": "$HOST",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$ID/"]
}
EOF
echo "Registered $HOST for chrome-extension://$ID/ in $DIR/$NAME.json"
echo "Recorded shu ($SHU) and SHU_HOME (${SHU_HOME_VALUE:-not set}) in $CONFIG"
