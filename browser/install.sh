#!/bin/sh
# Registers browser/host.py with Chrome, so that the SHU extension may start it.
#
#   sh browser/install.sh <extension ID>
#
# The ID is on chrome://extensions once browser/chrome is loaded unpacked. It stays
# the same while the folder does not move; after a move, load it again and rerun this.
#
#   SHU_CHROME_HOSTS_DIR   where Chrome looks for host manifests (default: Chrome's, per OS)
set -eu

NAME="io.github.dim0627.shu"
ID="${1:-}"

case "$ID" in
  "" | *[!a-p]*)
    echo "usage: sh browser/install.sh <extension ID: 32 letters a-p, from chrome://extensions>" >&2
    exit 1
    ;;
esac
if [ "${#ID}" -ne 32 ]; then
  echo "install.sh: an extension ID is 32 letters long: $ID" >&2
  exit 1
fi

HOST="$(cd "$(dirname "$0")" && pwd)/host.py"
case "$HOST" in
  *\"* | *\\*)
    echo "install.sh: the path cannot hold \" or \\ (it goes into JSON as is): $HOST" >&2
    exit 1
    ;;
esac

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

chmod +x "$HOST"
mkdir -p "$DIR"
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
