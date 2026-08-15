#!/bin/bash

set -u

PLUGIN_NAME="Wireless Output Manager"
PLUGIN_DIR="/data/plugins/system_hardware/wireless_output_manager"
BLUEALSA_OVERRIDE_DIR="/etc/systemd/system/bluealsa.service.d"
BLUEALSA_OVERRIDE="$BLUEALSA_OVERRIDE_DIR/50-wireless-output-manager-codecs.conf"

echo "[$PLUGIN_NAME] Removing plugin-owned ALSA contribution files"
rm -f "$PLUGIN_DIR/asound/womBluetooth.womBluetoothOut.-1.conf"
rm -f "$PLUGIN_DIR/asound/womBluetooth.womBluetoothOut.-1.conf.bak"

if [ -f "$BLUEALSA_OVERRIDE" ] && grep -q 'Managed by Wireless Output Manager' "$BLUEALSA_OVERRIDE"; then
  echo "[$PLUGIN_NAME] Removing the plugin-owned BlueALSA codec setting"
  rm -f "$BLUEALSA_OVERRIDE"
  rmdir "$BLUEALSA_OVERRIDE_DIR" 2>/dev/null || true
  systemctl daemon-reload
  systemctl restart bluealsa || echo "[$PLUGIN_NAME] Warning: BlueALSA could not be restarted; reboot to restore its previous codec configuration"
fi

echo "[$PLUGIN_NAME] Bluetooth pairings, system packages, unrelated service settings and global MPD configuration were preserved"
echo "pluginuninstallend"
