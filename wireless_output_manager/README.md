# Wireless Output Manager

Wireless Output Manager is an experimental Volumio 4 / Bookworm plugin that sends Volumio playback to a Bluetooth speaker. Bluetooth is the only implemented output type. AirPlay, Sonos, Chromecast and UPnP/DLNA are future architectural placeholders, not current features.

This version is intended for technical preview and community testing. It has not been submitted to the Volumio plugin beta channel.

## Tested configuration

The current version has been tested on:

- a Raspberry Pi running Volumio 4 / Bookworm;
- the existing BlueZ and BlueALSA stack on that device;
- a JBL PartyBox 100 Bluetooth speaker;
- manual switching between the JBL speaker and an iFi USB DAC;
- reconnect, plugin-only reset, reinstall and uninstall workflows.

Other Volumio 4 devices, Bluetooth speakers and audio configurations remain untested. The plugin deliberately does not install or replace the system audio stack.

## What works

- Bluetooth speaker discovery, pairing, trust, connection and disconnection;
- a simple onboarding flow: search, select, then use the selected speaker;
- a saved preferred speaker with optional automatic reconnection;
- explicit switching between the Bluetooth speaker and Volumio's normal audio output;
- read-only environment, Bluetooth, ALSA, audio-stack and MPD diagnostics;
- a guarded plugin-owned BlueALSA PCM contribution when BlueALSA is already installed;
- verification and rollback when the ALSA contribution cannot be exposed;
- a plugin-only setup reset that preserves system Bluetooth pairings;
- conservative uninstall behavior that preserves pairings, packages and MPD configuration.

The plugin does **not** install BlueALSA, PulseAudio or PipeWire and does **not** edit `/etc/mpd.conf` directly.

## Important limitations

- Audio routing is currently implemented only for an existing BlueALSA installation. Pairing and diagnostics may work on PulseAudio or PipeWire systems, but this version will not configure their audio routing.
- Switching audio destinations stops playback. Wait for the switch to complete, then press Play. The current track restarts from the beginning.
- Switching may take several seconds while MPD releases and reopens its audio device.
- There is no automatic fallback when a Bluetooth speaker is turned off, disconnects or becomes unavailable. Select **Play on default audio output** manually, wait for the route change, then press Play.
- Pairing that requires a PIN or confirmation agent may need to be completed with `bluetoothctl` over SSH.
- With Volumio **Mixer Type** set to **Hardware**, Bluetooth is effectively sent at 100%; Volumio's volume control continues to apply to the physical DAC instead. Use **Software** mixer mode if you want Volumio to control Bluetooth playback volume.

## Install from the forum preview branch

Connect to the Volumio device over SSH, then run:

```bash
cd /tmp
git clone --branch feat/wireless-output-manager --single-branch \
  https://github.com/jhscann/volumio-plugins-sources-bookworm.git \
  wireless-output-manager-src
cd /tmp/wireless-output-manager-src/wireless_output_manager
volumio plugin install
```

Confirm the warning for manually installed, unverified plugins. After installation, open **Plugins**, enable **Wireless Output Manager**, then open its settings page.

The `/tmp/wireless-output-manager-src` checkout may disappear after a reboot. That does not remove the installed plugin. Clone it again if you later need a fresh source checkout.

## Update a forum preview installation

1. Choose **Play on default audio output**.
2. Remove the installed plugin from Volumio's Plugins page. System Bluetooth pairings are preserved.
3. If the source checkout still exists, update and reinstall it:

```bash
cd /tmp/wireless-output-manager-src
git pull --ff-only
cd wireless_output_manager
volumio plugin install
```

If the source checkout no longer exists, repeat the installation commands above instead. Enable the plugin again after installation. A previously paired speaker normally reconnects without being put into pairing mode.

## Set up a Bluetooth speaker

1. Put the speaker in pairing mode. A speaker already paired with this Volumio device normally does not need pairing mode again.
2. Open **Plugins → Wireless Output Manager**.
3. Select **Search for speakers** and wait approximately 12 seconds.
4. Choose the speaker under **Available speakers**.
5. Select **Use selected speaker**. The plugin powers on Bluetooth, pairs, trusts, connects and saves the speaker.
6. Under **Choose where music plays**, select **Play on Bluetooth speaker**.
7. Wait for the route change to finish, then press Play.

The speaker list shows the state BlueZ currently reports:

- **selected**: the speaker saved by this plugin;
- **connected**: an active Bluetooth connection exists;
- **paired**: the system pairing is preserved;
- **audio**: BlueZ has confirmed a supported audio profile;
- **unidentified device**: BlueZ has not exposed enough profile information yet.

Devices positively identified as non-audio are hidden from the speaker list. Unidentified devices remain visible because some speakers reveal their audio profile only after pairing. If more than one audio speaker is connected, the status text names them and explains how to resolve the conflict.

Speaker selection and audio routing are intentionally separate. **Use selected speaker** establishes which single Bluetooth speaker is connected and saved. **Play on Bluetooth speaker** then routes Volumio playback to that connected speaker. This keeps destination changes explicit and avoids automatic fallback or routing surprises.

To return to the output already selected in Volumio Playback Options, choose **Play on default audio output**, wait for the switch to finish, then press Play.

## Everyday controls

- **Reconnect speaker** reconnects the saved speaker without changing the audio destination.
- **Disconnect speaker** returns active Bluetooth routing to the default output before disconnecting.
- **Reconnect automatically** reconnects the saved speaker when it becomes available. It never changes the selected audio destination and does not provide automatic fallback when the speaker becomes unavailable.
- **Reset speaker setup** returns to the default output and clears only this plugin's saved speaker and routing state. It preserves system-wide Bluetooth pairings so other Bluetooth plugins are not disrupted.

To use a different speaker, repeat the search, selection and **Use selected speaker** workflow. The plugin returns active Bluetooth routing to the default output, disconnects every other connected device that BlueZ confirms is an audio speaker, and connects the newly selected speaker. All pairings are preserved, and confirmed non-audio Bluetooth devices are not touched. The existing saved speaker is replaced only after the new speaker connects successfully. Choose **Play on Bluetooth speaker** afterward when you are ready to route music to it.

If the new speaker cannot connect, the previous speaker remains selected and the plugin attempts to reconnect it. Music remains routed to the default output so the UI never claims that audio was switched successfully.

## Diagnostics

Open **Diagnostics** and select **Run diagnostics**. **Export debug log** writes a JSON report under:

```text
/data/INTERNAL/wireless-output-manager/
```

The report contains command output but no plugin secrets. Useful manual checks include:

```bash
bluetoothctl show
bluetoothctl devices
bluetoothctl devices Paired
bluetoothctl devices Connected
bluetoothctl info <MAC>
systemctl status bluetooth --no-pager
rfkill list bluetooth
aplay -L
aplay -l
mpc outputs
```

For an existing BlueALSA installation:

```bash
systemctl status bluealsa --no-pager
bluealsa-aplay -L
```

Common messages:

- **Bluetooth service unavailable**: check `rfkill` and `bluetooth.service`.
- **Preferred speaker unavailable**: turn on the speaker and make sure another source has not claimed it.
- **No supported Bluetooth audio sender**: the plugin found no existing supported sender and intentionally installed nothing.
- **PCM not exposed**: the guarded ALSA contribution was rolled back; export diagnostics for investigation.

## Uninstall

First choose **Play on default audio output**, then remove the plugin through Volumio's Plugins page.

Uninstall removes only the plugin-owned ALSA contribution. It preserves:

- system Bluetooth pairings;
- BlueZ and audio-stack packages;
- `/etc/mpd.conf`;
- exported diagnostics under `/data/INTERNAL`.

## Reporting a test result

When reporting a problem, include:

- the Volumio version and Raspberry Pi model;
- the Bluetooth speaker make and model;
- whether BlueALSA, PulseAudio or PipeWire is installed;
- the action that failed and the exact message shown;
- an exported diagnostic report, after reviewing it for any information you do not want to share.

## Future output adapters

The internal adapter boundary allows future AirPlay, Sonos, Chromecast and UPnP/DLNA implementations. Those protocols often use remote stream or queue models rather than ALSA devices, so they will be implemented and tested independently.
