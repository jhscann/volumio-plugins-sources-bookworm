#!/bin/bash

set -u

PLUGIN_NAME="Wireless Output Manager"
PLUGIN_DIR="/data/plugins/system_hardware/wireless_output_manager"

echo "[$PLUGIN_NAME] Removing plugin-owned ALSA contribution files"
rm -f "$PLUGIN_DIR/asound/womBluetooth.womBluetoothOut.-1.conf"
rm -f "$PLUGIN_DIR/asound/womBluetooth.womBluetoothOut.-1.conf.bak"

echo "[$PLUGIN_NAME] Bluetooth pairings, system packages and global MPD configuration were preserved"
echo "pluginuninstallend"
