# Phase 0 technical assessment

## Scope and evidence

The development checkout is not a Raspberry Pi running Volumio. Therefore it cannot establish the target's kernel, BlueZ version, active services, installed audio packages, ALSA cards or MPD outputs. Those facts must be collected on the target. The plugin's read-only diagnostics module collects them without installing packages or changing configuration.

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
3. The plugin does not directly edit `/etc/mpd.conf` and does not claim the PCM is selectable until target-device validation proves it.
4. If only PulseAudio or PipeWire is present, the initial version reports that stack but does not create routing. Installing a second audio stack automatically is unsafe.
5. If no sender is present, pairing, reconnect and diagnostics remain available while audio creation returns a clear unsupported message.

This is the least-invasive implementation supported by the evidence available without access to an actual Volumio 4 device.

## Target-device verification

Run **Diagnostics → Run diagnostics** before creating an output. Verify:

- Volumio, Debian, kernel, Node.js and BlueZ versions.
- `bluetooth.service`, rfkill and existing receiver/input functionality.
- BlueALSA, PulseAudio and PipeWire packages and services.
- ALSA device enumeration from `aplay -L`, `aplay -l` and `/proc/asound/cards`.
- MPD's generated output state from `mpc outputs` and the read-only relevant lines of `/etc/mpd.conf`.

No automatic output selection should be added until this evidence is captured from a representative Volumio 4 Raspberry Pi.
