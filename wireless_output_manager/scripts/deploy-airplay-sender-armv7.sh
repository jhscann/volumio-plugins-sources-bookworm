#!/bin/bash

set -euo pipefail

PLUGIN_DIR="/data/plugins/system_hardware/wireless_output_manager"
BUNDLE_DIR="${1:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}"
SOURCE_BINARY="$BUNDLE_DIR/cliairplay-linux-arm"
TARGET_BINARY="$PLUGIN_DIR/bin/airplay/cliairplay-linux-arm"
EXPECTED_SHA256="704adb5a10aa1d29c648c1b570184c09bc704ef12cb8d9581156e24dbbca01ce"
HAD_PREVIOUS_SENDER=0

fail() {
  echo "Deployment stopped: $*" >&2
  exit 1
}

[ "$(uname -m)" = "armv7l" ] || fail "this sender is only for an ARMv7 system"
[ "$(getconf LONG_BIT)" = "32" ] || fail "the userland is not 32-bit"
[ "$(dpkg --print-architecture)" = "armhf" ] || fail "the Debian architecture is not armhf"
[ -d "$PLUGIN_DIR" ] || fail "Wireless Output Manager is not installed"
[ -f "$SOURCE_BINARY" ] || fail "the verified sender is missing from $BUNDLE_DIR"

ACTUAL_SHA256="$(sha256sum "$SOURCE_BINARY" | awk '{print $1}')"
[ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ] || fail "the sender checksum does not match"

BACKUP_DIR="/data/INTERNAL/wom-before-armv7-sender-$(date +%Y%m%d-%H%M%S)"
echo "Stopping playback"
mpc stop >/dev/null 2>&1 || true

sudo mkdir -p "$BACKUP_DIR"
if [ -e "$TARGET_BINARY" ]; then
  echo "Backing up the current sender to $BACKUP_DIR"
  sudo cp -a "$TARGET_BINARY" "$BACKUP_DIR/cliairplay-linux-arm.before"
  HAD_PREVIOUS_SENDER=1
else
  echo "No existing AirPlay sender is installed; this is a first-time installation"
fi

restore_sender() {
  if [ "$HAD_PREVIOUS_SENDER" -eq 1 ]; then
    echo "The new sender failed; restoring the previous file" >&2
    sudo cp -a "$BACKUP_DIR/cliairplay-linux-arm.before" "$TARGET_BINARY"
  elif [ -e "$TARGET_BINARY" ]; then
    echo "The new sender failed; preserving it in the backup directory" >&2
    sudo mv "$TARGET_BINARY" "$BACKUP_DIR/cliairplay-linux-arm.failed"
  fi
}

echo "Installing the verified native ARMv7 sender"
sudo mkdir -p "$PLUGIN_DIR/bin/airplay"
sudo install -o volumio -g volumio -m 0755 "$SOURCE_BINARY" "$TARGET_BINARY"
sudo install -o volumio -g volumio -m 0644 \
  "$BUNDLE_DIR/LICENSE.cliairplay" \
  "$PLUGIN_DIR/bin/airplay/LICENSE.cliairplay"
sudo install -o volumio -g volumio -m 0644 \
  "$BUNDLE_DIR/THIRD_PARTY_NOTICES.cliairplay.md" \
  "$PLUGIN_DIR/bin/airplay/THIRD_PARTY_NOTICES.cliairplay.md"

if ! "$TARGET_BINARY" --check; then
  restore_sender
  fail "the previous sender was restored"
fi

echo "Restarting Volumio"
sudo systemctl restart volumio
sleep 5

[ "$(systemctl is-active volumio)" = "active" ] || {
  restore_sender
  sudo systemctl restart volumio
  fail "Volumio did not become active; the previous sender was restored"
}

echo
echo "ARMv7 sender deployment passed"
echo "Backup: $BACKUP_DIR"
echo "Checksum: $ACTUAL_SHA256"
systemctl show volumio -p NRestarts
