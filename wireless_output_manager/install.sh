#!/bin/bash

set -u

PLUGIN_NAME="Wireless Output Manager"

echo "[$PLUGIN_NAME] Checking Volumio 4 prerequisites"

missing_required=0
for command_name in bluetoothctl busctl systemctl aplay node; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "[$PLUGIN_NAME] Required command is missing: $command_name"
    missing_required=1
  fi
done

if [ "$missing_required" -ne 0 ]; then
  echo "[$PLUGIN_NAME] Installation cannot continue without the required base-system tools"
  exit 1
fi

if command -v bluealsa >/dev/null 2>&1; then
  echo "[$PLUGIN_NAME] Existing BlueALSA sender detected; guarded ALSA output can be enabled after diagnostics"
elif command -v pactl >/dev/null 2>&1 || command -v pw-cli >/dev/null 2>&1; then
  echo "[$PLUGIN_NAME] PulseAudio or PipeWire detected; control and diagnostics are available, but automatic audio routing is not enabled"
else
  echo "[$PLUGIN_NAME] No supported sender backend detected; no audio packages will be installed automatically"
fi

echo "[$PLUGIN_NAME] No global Bluetooth, ALSA or MPD configuration was changed"
echo "plugininstallend"
