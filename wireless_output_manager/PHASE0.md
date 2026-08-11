# Phase 0 technical assessment

## Initial scope and evidence

The initial development checkout was not a Raspberry Pi running Volumio, so the architecture decision began with repository inspection and read-only diagnostics. No packages or system configuration were changed during that investigation.

Repository inspection established the following Volumio 4 / Bookworm conventions:

- Plugins target Node.js 20 or newer and Volumio 4.
- Audio plugins can declare `has_alsa_contribution` and provide narrowly scoped fragments under their own `asound/` directory.
- The supported rebuild entrypoint used by current Bookworm plugins is `audio_interface/alsa_controller.updateALSAConfigFile`.
- Playback configuration is owned by Volumio's `alsa_controller` and MPD plugin. Existing backend source reads `outputdevice` from `alsa_controller` and generates `/etc/mpd.conf`; a separate plugin should not patch that generated file.
- Volumio's normal selector is based on enumerated ALSA hardware cards. An arbitrary named virtual PCM is not proven to appear in Playback Options and must not be silently selected through undocumented internals.
- The repository already contains Bluetooth receiver/remote functionality. Starting a competing daemon or installing another sound server could conflict with it.

## Architecture decision

Bluetooth control uses the system's existing BlueZ `bluetoothctl`. Audio output is deliberately conditional:

1. If BlueALSA already exists, the plugin may create a plugin-owned `womBluetooth` ALSA PCM contribution and request a normal ALSA rebuild.
2. The PCM is verified with `aplay -L`; failure triggers rollback.
3. The plugin does not directly edit `/etc/mpd.conf`. It exposes and verifies its plugin-owned PCM through Volumio's ALSA contribution mechanism.
4. If only PulseAudio or PipeWire is present, the initial version reports that stack but does not create routing. Installing a second audio stack automatically is unsafe.
5. If no sender is present, pairing, reconnect and diagnostics remain available while audio creation returns a clear unsupported message.

This is the least-invasive implementation supported by the evidence available without access to an actual Volumio 4 device.

## Completed target-device verification

The Bluetooth implementation was subsequently tested on a Raspberry Pi running Volumio 4 / Bookworm with an existing BlueALSA sender. Testing confirmed:

- discovery, pairing, trust and connection of a JBL PartyBox 100;
- exposure of the `womBluetooth` and `womBluetoothOut` ALSA PCMs;
- playback through the JBL PartyBox 100;
- manual switching between Bluetooth and an iFi USB DAC;
- safe fallback to the default output when Bluetooth routing is removed;
- reconnect, plugin-only reset, reinstall and conservative uninstall behavior;
- preservation of system Bluetooth pairings during reset and uninstall.

The tested device showed that output switching can be slow while playback releases and reopens the audio path. The released workflow therefore stops playback deliberately and asks the user to press Play after switching; playback-position preservation is not attempted in this version.

## Verification on additional devices

Run **Diagnostics → Run diagnostics** before creating an output. Verify:

- Volumio, Debian, kernel, Node.js and BlueZ versions.
- `bluetooth.service`, rfkill and existing receiver/input functionality.
- BlueALSA, PulseAudio and PipeWire packages and services.
- ALSA device enumeration from `aplay -L`, `aplay -l` and `/proc/asound/cards`.
- MPD's generated output state from `mpc outputs` and the read-only relevant lines of `/etc/mpd.conf`.

Capture this evidence before reporting compatibility with a new Volumio image, audio stack or hardware family. The current positive result applies only to the tested BlueALSA configuration; PulseAudio and PipeWire routing remain unimplemented.
