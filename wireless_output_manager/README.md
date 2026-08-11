# Wireless Output Manager

Wireless Output Manager is an experimental Volumio 4 / Bookworm plugin for sending playback to an external wireless speaker. Bluetooth speaker control is the only implemented backend. AirPlay, Sonos, Chromecast and UPnP/DLNA are architectural placeholders, not advertised features.

## Current status

The plugin provides:

- bounded Bluetooth discovery, pairing, trust, connect, disconnect and forget operations;
- audio-profile-aware device ordering when BlueZ exposes UUIDs;
- a persisted preferred speaker and a bounded 15-second reconnect monitor;
- explicit, manual switching between Bluetooth and the selected Volumio hardware output;
- read-only environment, Bluetooth, ALSA/audio-stack and MPD diagnostics;
- a guarded, plugin-owned BlueALSA PCM contribution when BlueALSA is already installed;
- verification and rollback if the ALSA contribution cannot be exposed;
- conservative installation and removal that preserve pairings, packages and MPD configuration.

It does **not** install BlueALSA, PulseAudio or PipeWire. It does **not** edit `/etc/mpd.conf`. A virtual BlueALSA PCM is not guaranteed to appear in Volumio's hardware-oriented Playback Options selector; target-device validation is still required. See [PHASE0.md](PHASE0.md).

## Install

On a Volumio 4 / Bookworm device, place this directory in a plugin-source checkout, enter it, and run:

```bash
volumio plugin install
```

The installer checks required base-system commands and reports the existing audio stack. It makes no global audio changes.

## Pair and connect

1. Open **Plugins → Wireless Output Manager**.
2. Put the Bluetooth speaker in pairing mode.
3. Select **Find Bluetooth speakers** and wait for discovery to finish.
4. Choose the speaker under **Available speakers**.
5. Select **Pair & connect**. The plugin powers on Bluetooth, pairs, trusts, connects and saves the speaker in one operation.
6. Under **Choose where music plays**, select **Play on Bluetooth speaker**.
7. Press Play after the route change completes.

Previously paired speakers do not need pairing mode. Use **Reconnect speaker** instead. **Forget speaker** removes the BlueZ pairing, so pairing mode is required the next time it is added.

Pairing modes that require a PIN or confirmation agent may need to be completed with `bluetoothctl` over SSH in this initial version.

## Reconnect and output selection

When enabled, the plugin checks the preferred device after startup and every 15 seconds. It never spins in a tight loop or overlaps reconnect attempts. A missing or powered-off speaker is reported as unavailable and does not prevent plugin startup.

Routing is deliberately manual. Choose **Play on Bluetooth speaker** to route Volumio through the connected saved speaker, or **Play on default audio output** to return to the hardware device selected in Playback Options. Either button stops playback first and leaves it stopped; press Play after the switch completes. The current track restarts from the beginning. Auto-reconnect reconnects Bluetooth only; it never changes the selected audio route.

## Volume

With **Playback Options → Mixer Type** set to **Hardware**, Volumio does not apply software attenuation to the Bluetooth path: Bluetooth is effectively sent at 100%, while Volumio's volume control applies only to the physical DAC. Choose **Software** if you want Volumio's volume control to affect Bluetooth playback. You may switch back to Hardware when using the default DAC.

## Diagnostics and troubleshooting

Use **Diagnostics → Run diagnostics**. Export writes a JSON report under `/data/INTERNAL/wireless-output-manager/`; it contains command output but no plugin secrets.

Useful manual checks are:

```bash
bluetoothctl show
bluetoothctl devices
bluetoothctl devices Paired
bluetoothctl info <MAC>
systemctl status bluetooth --no-pager
journalctl -u bluetooth --since "30 minutes ago" --no-pager
rfkill list bluetooth
aplay -L
aplay -l
cat /proc/asound/cards
mpc outputs
```

For an existing BlueALSA installation:

```bash
systemctl status bluealsa --no-pager
bluealsa-aplay -L
```

For an existing PulseAudio or PipeWire installation:

```bash
pactl info
pactl list short sinks
pactl list short cards
pw-cli info all
```

Common messages:

- **Bluetooth service unavailable**: check rfkill and `bluetooth.service`.
- **Preferred speaker unavailable**: turn it on and ensure another source has not claimed it.
- **No supported Bluetooth audio sender**: the plugin intentionally did not install a second audio stack. Review the Phase 0 report for the target and choose a compatible system architecture first.
- **PCM not exposed**: the guarded contribution was rolled back; inspect the exported diagnostics.

## Safe uninstall

Run the standard Volumio plugin removal. Uninstall deletes only the plugin-owned ALSA contribution. It preserves Bluetooth pairings, BlueZ, BlueALSA/PulseAudio/PipeWire packages, `/etc/mpd.conf`, and user diagnostics under `/data/INTERNAL`.

## Future adapters

The adapter boundary reserves AirPlay, Sonos, Chromecast and UPnP/DLNA. These protocols often use remote stream and queue models rather than ALSA devices, with different latency, authentication and synchronization behavior. They will be implemented independently only when they can meet Volumio reliability expectations.
