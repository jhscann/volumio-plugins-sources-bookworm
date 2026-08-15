#!/bin/bash

set -u

PLUGIN_NAME="Wireless Output Manager"
BLUEALSA_OVERRIDE_DIR="/etc/systemd/system/bluealsa.service.d"
BLUEALSA_OVERRIDE="$BLUEALSA_OVERRIDE_DIR/50-wireless-output-manager-codecs.conf"

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

  if bluealsa --help 2>&1 | grep -Eq 'a2dp-source:.*LDAC'; then
    if bluealsa-cli status 2>/dev/null | grep -Eq 'A2DP-source[[:space:]]*:.*LDAC'; then
      echo "[$PLUGIN_NAME] BlueALSA LDAC sender support is already active; no service change was needed"
    elif [ -f "$BLUEALSA_OVERRIDE" ] && ! grep -q 'Managed by Wireless Output Manager' "$BLUEALSA_OVERRIDE"; then
      echo "[$PLUGIN_NAME] The codec override path is owned by another configuration; LDAC was not enabled"
    else
      override_backup=""
      if [ -f "$BLUEALSA_OVERRIDE" ]; then
        override_backup="$(mktemp)"
        cp -p "$BLUEALSA_OVERRIDE" "$override_backup"
        rm -f "$BLUEALSA_OVERRIDE"
        systemctl daemon-reload
      fi
      bluealsa_exec="$(systemctl cat bluealsa --no-pager 2>/dev/null | sed -n 's/^[[:space:]]*ExecStart=//p' | sed '/^[[:space:]]*$/d' | tail -n 1)"
      case "$bluealsa_exec" in
        */bluealsa*)
          override_temp="$(mktemp)"
          {
            echo '# Managed by Wireless Output Manager. Adds an available codec; preserves the existing BlueALSA command.'
            echo '[Service]'
            echo 'ExecStart='
            printf 'ExecStart=%s -c LDAC\n' "$bluealsa_exec"
          } > "$override_temp"
          mkdir -p "$BLUEALSA_OVERRIDE_DIR"
          install -m 0644 "$override_temp" "$BLUEALSA_OVERRIDE"
          rm -f "$override_temp"

          systemctl daemon-reload
          if systemctl restart bluealsa; then
            ldac_ready=0
            for attempt in 1 2 3 4 5; do
              if bluealsa-cli status 2>/dev/null | grep -Eq 'A2DP-source[[:space:]]*:.*LDAC'; then
                ldac_ready=1
                break
              fi
              sleep 1
            done
          else
            ldac_ready=0
          fi

          if [ "$ldac_ready" -eq 1 ]; then
            echo "[$PLUGIN_NAME] Enabled and verified BlueALSA LDAC sender support; SBC remains available"
            [ -n "$override_backup" ] && rm -f "$override_backup"
          else
            echo "[$PLUGIN_NAME] LDAC service verification failed; restoring the previous BlueALSA configuration"
            if [ -n "$override_backup" ]; then
              install -m 0644 "$override_backup" "$BLUEALSA_OVERRIDE"
              rm -f "$override_backup"
            else
              rm -f "$BLUEALSA_OVERRIDE"
            fi
            systemctl daemon-reload
            systemctl restart bluealsa || true
          fi
          ;;
        *)
          echo "[$PLUGIN_NAME] Could not safely determine the existing BlueALSA service command; LDAC was not enabled"
          if [ -n "$override_backup" ]; then
            install -m 0644 "$override_backup" "$BLUEALSA_OVERRIDE"
            rm -f "$override_backup"
            systemctl daemon-reload
          fi
          ;;
      esac
    fi
  else
    echo "[$PLUGIN_NAME] Installed BlueALSA build does not provide LDAC sender support; service was not changed"
  fi
elif command -v pactl >/dev/null 2>&1 || command -v pw-cli >/dev/null 2>&1; then
  echo "[$PLUGIN_NAME] PulseAudio or PipeWire detected; control and diagnostics are available, but automatic audio routing is not enabled"
else
  echo "[$PLUGIN_NAME] No supported sender backend detected; no audio packages will be installed automatically"
fi

echo "[$PLUGIN_NAME] Bluetooth pairings, Volumio core files and MPD configuration were not changed"
echo "plugininstallend"
