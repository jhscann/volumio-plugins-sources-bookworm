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

Other Volumio 4 devices, Bluetooth speakers and audio configurations remain untested. The plugin deliberately does not install or replace the system audio stack. LDAC has been validated with Soundcore P31i earbuds; aptX and aptX HD support remain experimental pending real-device testing.

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
- runtime resolution of a paired speaker's owning Bluetooth controller, including systems where `hci0` and `hci1` change across reboots.
- automatic or explicit per-device codec selection for speakers, headphones and earbuds, using codecs shared by BlueALSA and the connected device;
- guarded LDAC, aptX and aptX HD enablement when the installed BlueALSA build already contains the corresponding encoders.
- one bounded, selected-device reconnect when BlueZ reports a connection but BlueALSA has no usable audio stream, such as immediately after the codec service is restarted;

The plugin does **not** install or replace BlueALSA, PulseAudio or PipeWire and does **not** edit `/etc/mpd.conf` directly. On a compatible BlueALSA installation it adds one plugin-owned systemd drop-in that enables the already-installed LDAC, aptX and aptX HD codecs. The existing service command and profiles are preserved, the result is verified, and a failed change is rolled back.

## Important limitations

- Audio routing is currently implemented only for an existing BlueALSA installation. Pairing and diagnostics may work on PulseAudio or PipeWire systems, but this version will not configure their audio routing.
- Switching audio destinations stops playback. Wait for the switch to complete, then press Play. The current track restarts from the beginning.
- Switching may take several seconds while MPD releases and reopens its audio device.
- There is no automatic fallback when a Bluetooth speaker is turned off, disconnects or becomes unavailable. Select **Play on default audio output** manually, wait for the route change, then press Play.
- Pairing that requires a PIN or confirmation agent may need to be completed with `bluetoothctl` over SSH.
- On systems with multiple Bluetooth controllers, reconnect, disconnect, trust and forget operations target the BlueZ device object that owns the pairing. Controller indexes such as `hci0` are deliberately not saved because Linux may renumber them after reboot. User-initiated discovery still follows the controller selected by BlueZ, so advanced first-time pairing arrangements may require selecting the intended controller in `bluetoothctl`.
- With Volumio **Mixer Type** set to **Hardware**, Bluetooth is effectively sent at 100%; Volumio's volume control continues to apply to the physical DAC instead. Use **Software** mixer mode if you want Volumio to control Bluetooth playback volume.
- Codec support depends on both the connected device and the BlueALSA build supplied by the system. The tested Volumio 4 build contains LDAC, aptX and aptX HD but was not compiled with AAC, so this plugin cannot offer AAC without replacing system audio packages. It intentionally does not do that. aptX Adaptive is not provided by BlueALSA 4.3.1 and is not supported by this plugin; compatible headphones may instead offer standard aptX or aptX HD fallback.

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

During installation, a compatible BlueALSA service is restarted once to enable its existing LDAC, aptX and aptX HD encoders. Only codecs present in the installed BlueALSA build are enabled. Bluetooth devices may disconnect briefly and can then be reconnected normally. SBC remains available. If the requested codecs cannot be verified, the installer restores the previous service configuration and the plugin continues with the codecs already provided by the system.

If BlueZ retains a stale connected state after that restart but no Bluetooth audio stream exists, the first **Play on Bluetooth speaker** request performs one bounded reconnect of the selected device on its owning adapter. It does not restart Bluetooth, change the default adapter or touch unrelated devices.

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
- **Paired audio devices → Forget selected device** removes any listed audio device's system Bluetooth pairing, even when that device is switched off or disconnected. If it is the active selected device, the plugin returns to the default output and clears the selection first. Pairing mode will be required to add it again. Other paired devices are not affected, and confirmed non-audio devices are not offered in this list.
- **Reconnect automatically** reconnects the saved speaker when it becomes available. It never changes the selected audio destination and does not provide automatic fallback when the speaker becomes unavailable.
- **Reset speaker setup** returns to the default output and clears only this plugin's saved speaker and routing state. It preserves system-wide Bluetooth pairings so other Bluetooth plugins are not disrupted.

## Bluetooth audio codecs

The codec preference is saved separately for each Bluetooth audio device, including speakers, headphones and earbuds. Connect the device, then open **Preferences → Bluetooth audio codec**:

- **Automatic — best available** chooses LDAC first, then aptX HD, AAC, aptX and SBC from the codecs mutually reported for that connection;
- choosing **LDAC**, **aptX HD**, **AAC**, **aptX** or **SBC** explicitly requires that codec and fails clearly rather than silently falling back;
- the selected codec is applied and verified when you choose **Play on Bluetooth speaker**;
- before a manual routing change, the plugin captures Volumio's volume and mute state, then temporarily mutes at 0%. After configuring the output and codec, it uses BlueALSA's device-scoped mixer to cap only the selected Bluetooth device at 10%; it never raises a device already below the cap. The saved Volumio volume is restored while still muted and must remain stable before the original mute state is restored. If either safety state cannot be verified, playback remains stopped and the plugin tells you to set a safe volume manually before pressing Play.

When the selected Bluetooth device is connected, **Choose where music plays** shows two separate controls: **Bluetooth device volume** for the speaker/headphones hardware level, and **Volumio software volume** for Volumio's global digital level. Effective loudness depends on both. The plugin displays but does not change the global mixer mode; change Hardware or Software mixer mode only in Volumio **Playback Options**.

Only codecs reported by the current connection are offered in the selector. Some headphones require their high-quality codec mode to be enabled in the manufacturer's app before they advertise LDAC. LDAC can consume more battery and may be less stable in a congested 2.4 GHz environment; select SBC if reliability is more important than bitrate. aptX Adaptive itself is not available, although an aptX Adaptive device may expose standard aptX or aptX HD as a backward-compatible connection.

To use a different speaker, repeat the search, selection and **Use selected speaker** workflow. The plugin returns active Bluetooth routing to the default output, disconnects every other connected device that BlueZ confirms is an audio speaker, and connects the newly selected speaker. All pairings are preserved, and confirmed non-audio Bluetooth devices are not touched. The existing saved speaker is replaced only after the new speaker connects successfully. Choose **Play on Bluetooth speaker** afterward when you are ready to route music to it.

Before changing a working connection, the plugin first confirms that the newly selected device can connect. If it is switched off or unavailable, the current speaker, saved selection and audio route are left unchanged and the UI asks you to turn on the selected device and try again.

## Diagnostics

Open **Diagnostics** and select **Run diagnostics**. **Export debug log** writes a JSON report under:

```text
/data/INTERNAL/wireless-output-manager/
```

The report contains command output but no plugin secrets. Useful manual checks include:

```bash
bluetoothctl show
bluetoothctl list
bluetoothctl devices
bluetoothctl devices Paired
bluetoothctl devices Connected
bluetoothctl info <MAC>
busctl --system tree org.bluez
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
bluealsa-cli status
bluealsa-cli list-pcms
bluealsa-cli info <PCM-PATH>
```

Common messages:

- **Bluetooth service unavailable**: check `rfkill` and `bluetooth.service`.
- **Preferred speaker unavailable**: turn on the speaker and make sure another source has not claimed it.
- **No supported Bluetooth audio sender**: the plugin found no existing supported sender and intentionally installed nothing.
- **PCM not exposed**: the guarded ALSA contribution was rolled back; export diagnostics for investigation.

## Uninstall

First choose **Play on default audio output**, then remove the plugin through Volumio's Plugins page.

Uninstall removes the plugin-owned ALSA contribution and its plugin-owned BlueALSA codec drop-in, then reloads the original BlueALSA service command. It preserves:

- system Bluetooth pairings;
- BlueZ and audio-stack packages;
- `/etc/mpd.conf`;
- every unrelated systemd service setting;
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
