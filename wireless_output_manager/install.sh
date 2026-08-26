#!/bin/bash

set -u

PLUGIN_NAME="Wireless Output Manager"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
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

for sender_binary in "$SCRIPT_DIR"/bin/airplay/cliairplay-*; do
  if [ -f "$sender_binary" ]; then
    chmod 0755 "$sender_binary"
  fi
done

# Volumio installs plugins from a ZIP archive, which does not reliably preserve
# executable bits. The mixed armhf/aarch64 AirPlay wrapper invokes this private
# dynamic loader directly, so it must be executable as well as the wrapper and
# sender binary above.
if [ -d "$SCRIPT_DIR/bin/airplay/runtime-arm64" ]; then
  find "$SCRIPT_DIR/bin/airplay/runtime-arm64" \
    -type f \
    -name 'ld-linux-aarch64.so*' \
    -exec chmod 0755 {} \;

  runtime_library_dir="$SCRIPT_DIR/bin/airplay/runtime-arm64/usr/lib/aarch64-linux-gnu"
  if [ -f "$runtime_library_dir/libstdc++.so.6.0.30" ]; then
    ln -sfn libstdc++.so.6.0.30 "$runtime_library_dir/libstdc++.so.6"
  fi
  if [ -f "$runtime_library_dir/libatomic.so.1.2.0" ]; then
    ln -sfn libatomic.so.1.2.0 "$runtime_library_dir/libatomic.so.1"
  fi
fi

if command -v bluealsa >/dev/null 2>&1; then
  echo "[$PLUGIN_NAME] Existing BlueALSA sender detected; guarded ALSA output can be enabled after diagnostics"

  bluealsa_help="$(bluealsa --help 2>&1 || true)"
  available_source_codecs="$(printf '%s\n' "$bluealsa_help" | sed -n 's/^[[:space:]]*a2dp-source:[[:space:]]*//p' | head -n 1 | tr ',' ' ')"
  codec_flags=""
  codec_names=""
  for codec_name in LDAC aptX-HD aptX; do
    case " $available_source_codecs " in
      *" $codec_name "*)
        codec_flags="$codec_flags -c $codec_name"
        codec_names="$codec_names $codec_name"
        ;;
    esac
  done

  if [ -n "$codec_flags" ]; then
    active_codecs="$(bluealsa-cli status 2>/dev/null | sed -n 's/^[[:space:]]*A2DP-source[[:space:]]*:[[:space:]]*//p' | head -n 1)"
    codecs_ready=1
    for codec_name in $codec_names; do
      case " $active_codecs " in
        *" $codec_name "*) ;;
        *) codecs_ready=0 ;;
      esac
    done

    if [ "$codecs_ready" -eq 1 ]; then
      echo "[$PLUGIN_NAME] BlueALSA optional sender codecs are already active:$codec_names; no service change was needed"
    elif [ -f "$BLUEALSA_OVERRIDE" ] && ! grep -q 'Managed by Wireless Output Manager' "$BLUEALSA_OVERRIDE"; then
      echo "[$PLUGIN_NAME] The codec override path is owned by another configuration; optional codecs were not enabled"
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
            echo '# Managed by Wireless Output Manager. Adds available codecs; preserves the existing BlueALSA command.'
            echo '[Service]'
            echo 'ExecStart='
            printf 'ExecStart=%s%s\n' "$bluealsa_exec" "$codec_flags"
          } > "$override_temp"
          mkdir -p "$BLUEALSA_OVERRIDE_DIR"
          install -m 0644 "$override_temp" "$BLUEALSA_OVERRIDE"
          rm -f "$override_temp"

          systemctl daemon-reload
          if systemctl restart bluealsa; then
            codecs_ready=0
            for attempt in 1 2 3 4 5; do
              active_codecs="$(bluealsa-cli status 2>/dev/null | sed -n 's/^[[:space:]]*A2DP-source[[:space:]]*:[[:space:]]*//p' | head -n 1)"
              codecs_ready=1
              for codec_name in $codec_names; do
                case " $active_codecs " in
                  *" $codec_name "*) ;;
                  *) codecs_ready=0 ;;
                esac
              done
              if [ "$codecs_ready" -eq 1 ]; then
                break
              fi
              sleep 1
            done
          else
            codecs_ready=0
          fi

          if [ "$codecs_ready" -eq 1 ]; then
            echo "[$PLUGIN_NAME] Enabled and verified BlueALSA optional sender codecs:$codec_names; SBC remains available"
            [ -n "$override_backup" ] && rm -f "$override_backup"
          else
            echo "[$PLUGIN_NAME] Optional codec service verification failed; restoring the previous BlueALSA configuration"
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
          echo "[$PLUGIN_NAME] Could not safely determine the existing BlueALSA service command; optional codecs were not enabled"
          if [ -n "$override_backup" ]; then
            install -m 0644 "$override_backup" "$BLUEALSA_OVERRIDE"
            rm -f "$override_backup"
            systemctl daemon-reload
          fi
          ;;
      esac
    fi
  else
    echo "[$PLUGIN_NAME] Installed BlueALSA build does not provide LDAC, aptX or aptX HD sender support; service was not changed"
  fi
elif command -v pactl >/dev/null 2>&1 || command -v pw-cli >/dev/null 2>&1; then
  echo "[$PLUGIN_NAME] PulseAudio or PipeWire detected; control and diagnostics are available, but automatic audio routing is not enabled"
else
  echo "[$PLUGIN_NAME] No supported sender backend detected; no audio packages will be installed automatically"
fi

echo "[$PLUGIN_NAME] Bluetooth pairings, Volumio core files and MPD configuration were not changed"
echo "plugininstallend"
