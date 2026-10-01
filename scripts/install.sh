#!/bin/sh
# SHU installer.
# Usage: curl -fsSL https://raw.githubusercontent.com/dim0627/shu/main/scripts/install.sh | sh
#
# Environment:
#   SHU_VERSION       release tag to install (default: the latest release)
#   SHU_INSTALL_DIR   where to put the binary (default: $HOME/.local/bin)
set -eu

REPO="dim0627/shu"
INSTALL_DIR="${SHU_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) echo "shu: unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) echo "shu: unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

asset="shu-$os-$arch"

# "latest" is resolved to a concrete tag so the binary and checksums.txt
# always come from the same release.
tag="${SHU_VERSION:-}"
if [ -z "$tag" ]; then
  tag=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")
  tag="${tag##*/}"
fi
case "$tag" in
  v*) ;;
  *) echo "shu: could not resolve the release tag (got: '$tag')" >&2; exit 1 ;;
esac

# SHU_DOWNLOAD_BASE exists for the test suite.
base="${SHU_DOWNLOAD_BASE:-https://github.com/$REPO/releases/download}/$tag"

tmp=$(mktemp -d)
staged=""
trap 'rm -rf "$tmp"; [ -z "$staged" ] || rm -f "$staged"' EXIT
trap 'exit 1' INT TERM

echo "Downloading $asset ($tag) ..."
curl -fsSL "$base/$asset" -o "$tmp/$asset"
curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt"

expected=$(awk -v name="$asset" '$2 == name { print $1 }' "$tmp/checksums.txt")
if [ -z "$expected" ]; then
  echo "shu: $asset is not listed in checksums.txt for $tag" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$asset" | cut -d' ' -f1)
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)
else
  echo "shu: neither sha256sum nor shasum was found; cannot verify the download" >&2
  exit 1
fi
if [ "$actual" != "$expected" ]; then
  echo "shu: SHA-256 mismatch for $asset" >&2
  echo "  expected: $expected" >&2
  echo "  actual:   $actual" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
# Staged inside INSTALL_DIR so the final mv is a rename on one filesystem:
# an existing shu is replaced atomically or not at all.
staged="$INSTALL_DIR/.shu.$$"
cp "$tmp/$asset" "$staged"
chmod 755 "$staged"
mv -f "$staged" "$INSTALL_DIR/shu"
staged=""

echo "Installed shu $tag to $INSTALL_DIR/shu"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "Note: $INSTALL_DIR is not on your PATH." ;;
esac
