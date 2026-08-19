#!/bin/bash

set -eu

VERSION="v0.5.2"
BASE_URL="https://github.com/music-assistant/airplay-cli/releases/download/$VERSION"
DEBIAN_URL="https://deb.debian.org/debian"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
TARGET_DIR="$SCRIPT_DIR/../bin/airplay"
KERNEL_ARCH="$(uname -m)"
USERLAND_BITS="$(getconf LONG_BIT 2>/dev/null || true)"
USERLAND_ARCH="$(dpkg --print-architecture 2>/dev/null || true)"
USE_PRIVATE_ARM64_RUNTIME=0

case "$(uname -s)-$KERNEL_ARCH" in
  Linux-aarch64|Linux-arm64)
    ASSET="cliairplay-linux-aarch64"
    CHECKSUM="39084fa17e28cd962ef8f295d559301eb37ce191fc390c11a105855c7c68cff0"
    if [ "$USERLAND_BITS" = "32" ] || [ "$USERLAND_ARCH" = "armhf" ]; then
      USE_PRIVATE_ARM64_RUNTIME=1
    fi
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

checksum_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

download_verified() {
  url="$1"
  destination="$2"
  expected="$3"
  curl -fsSL "$url" -o "$destination"
  actual="$(checksum_file "$destination")"
  if [ "$actual" != "$expected" ]; then
    echo "Checksum verification failed for $(basename "$destination")" >&2
    exit 1
  fi
}

echo "Downloading pinned AirPlay sender $VERSION for $ASSET"
download_verified "$BASE_URL/$ASSET" "$TEMP_DIR/$ASSET" "$CHECKSUM"
echo "$ASSET: checksum verified"
curl -fsSL "$BASE_URL/LICENSE" -o "$TEMP_DIR/LICENSE"
curl -fsSL "$BASE_URL/THIRD_PARTY_NOTICES.md" -o "$TEMP_DIR/THIRD_PARTY_NOTICES.md"

STAGED_DIR="$TEMP_DIR/airplay"
mkdir -p "$STAGED_DIR"
install -m 0755 "$TEMP_DIR/$ASSET" "$STAGED_DIR/$ASSET"
install -m 0644 "$TEMP_DIR/LICENSE" "$STAGED_DIR/LICENSE.cliairplay"
install -m 0644 "$TEMP_DIR/THIRD_PARTY_NOTICES.md" "$STAGED_DIR/THIRD_PARTY_NOTICES.cliairplay.md"

SENDER="$STAGED_DIR/$ASSET"
if [ "$USE_PRIVATE_ARM64_RUNTIME" = "1" ]; then
  if ! command -v dpkg-deb >/dev/null 2>&1; then
    echo "This 32-bit Volumio system needs dpkg-deb to extract the private arm64 runtime" >&2
    exit 1
  fi
  echo "Detected a 64-bit ARM kernel with a 32-bit armhf userland"
  echo "Preparing a private arm64 runtime inside the prototype directory"
  RUNTIME_DIR="$STAGED_DIR/runtime-arm64"
  mkdir -p "$RUNTIME_DIR"
  download_verified \
    "$DEBIAN_URL/pool/main/g/glibc/libc6_2.36-9+deb12u14_arm64.deb" \
    "$TEMP_DIR/libc6-arm64.deb" \
    "01f4330719fd4f65580e16ea5a0527f372fca750e8f588d26deaf09f2d3b1cf4"
  download_verified \
    "$DEBIAN_URL/pool/main/g/gcc-12/libgcc-s1_12.2.0-14+deb12u1_arm64.deb" \
    "$TEMP_DIR/libgcc-s1-arm64.deb" \
    "576926b283613db80168ddf76380a3bd877602778cf0d226caa7bfbfa71eacf3"
  download_verified \
    "$DEBIAN_URL/pool/main/g/gcc-12/libstdc++6_12.2.0-14+deb12u1_arm64.deb" \
    "$TEMP_DIR/libstdc++6-arm64.deb" \
    "26e138c677a985775331373828a6c286c551ff397cb735d00e2383cb273d1cb2"
  download_verified \
    "$DEBIAN_URL/pool/main/g/gcc-12/libatomic1_12.2.0-14+deb12u1_arm64.deb" \
    "$TEMP_DIR/libatomic1-arm64.deb" \
    "1693aa13ce2b30d061a519fc28b77b9bab8c8e45804ced5969d99821e1bc2159"
  for package in "$TEMP_DIR"/*-arm64.deb; do
    dpkg-deb -x "$package" "$RUNTIME_DIR"
  done
  cat > "$STAGED_DIR/cliairplay-linux-arm" <<'EOF'
#!/bin/sh
SELF_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
RUNTIME="$SELF_DIR/runtime-arm64"
exec "$RUNTIME/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1" \
  --library-path "$RUNTIME/lib/aarch64-linux-gnu:$RUNTIME/usr/lib/aarch64-linux-gnu" \
  "$SELF_DIR/cliairplay-linux-aarch64" "$@"
EOF
  chmod 0755 "$STAGED_DIR/cliairplay-linux-arm"
  SENDER="$STAGED_DIR/cliairplay-linux-arm"
fi

"$SENDER" --check
mkdir -p "$TARGET_DIR"
cp -R "$STAGED_DIR"/. "$TARGET_DIR"/
echo "Prototype sender installed under $TARGET_DIR"
if [ "$USE_PRIVATE_ARM64_RUNTIME" = "1" ]; then
  echo "The arm64 compatibility files are private to the prototype directory."
fi
echo "No service, system package, system library, capability or Volumio audio setting was changed."
