#!/bin/bash

set -eu

VERSION="v0.5.2"
BASE_URL="https://github.com/music-assistant/airplay-cli/releases/download/$VERSION"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
TARGET_DIR="$SCRIPT_DIR/../bin/airplay"

case "$(uname -s)-$(uname -m)" in
  Linux-aarch64|Linux-arm64)
    ASSET="cliairplay-linux-aarch64"
    CHECKSUM="39084fa17e28cd962ef8f295d559301eb37ce191fc390c11a105855c7c68cff0"
    ;;
  Linux-x86_64)
    ASSET="cliairplay-linux-x86_64"
    CHECKSUM="99695d5042d96f9b9decb4c6d694cc9c6c1bef52a4fca4e2eb1b2eec391dfe87"
    ;;
  Darwin-arm64)
    ASSET="cliairplay-macos-arm64"
    CHECKSUM="0f29fd6a43faa3f6d76256c2bc5c9d6017e213f90c44b8c1528fd0fd79a6f6df"
    ;;
  Darwin-x86_64)
    ASSET="cliairplay-macos-x86_64"
    CHECKSUM="aac1ed1444c64ab90f439c620e0ae83137af60e5ab0d8bdfee7c29eb864ea691"
    ;;
  *)
    echo "Unsupported prototype platform: $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

echo "Downloading pinned AirPlay sender $VERSION for $ASSET"
curl -fsSL "$BASE_URL/$ASSET" -o "$TEMP_DIR/$ASSET"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_CHECKSUM="$(sha256sum "$TEMP_DIR/$ASSET" | awk '{print $1}')"
else
  ACTUAL_CHECKSUM="$(shasum -a 256 "$TEMP_DIR/$ASSET" | awk '{print $1}')"
fi
if [ "$ACTUAL_CHECKSUM" != "$CHECKSUM" ]; then
  echo "Checksum verification failed for $ASSET" >&2
  exit 1
fi
echo "$ASSET: checksum verified"
curl -fsSL "$BASE_URL/LICENSE" -o "$TEMP_DIR/LICENSE"
curl -fsSL "$BASE_URL/THIRD_PARTY_NOTICES.md" -o "$TEMP_DIR/THIRD_PARTY_NOTICES.md"

mkdir -p "$TARGET_DIR"
install -m 0755 "$TEMP_DIR/$ASSET" "$TARGET_DIR/$ASSET"
install -m 0644 "$TEMP_DIR/LICENSE" "$TARGET_DIR/LICENSE.cliairplay"
install -m 0644 "$TEMP_DIR/THIRD_PARTY_NOTICES.md" "$TARGET_DIR/THIRD_PARTY_NOTICES.cliairplay.md"

"$TARGET_DIR/$ASSET" --check
echo "Prototype sender installed under $TARGET_DIR"
echo "No service, system package, capability or Volumio audio setting was changed."
