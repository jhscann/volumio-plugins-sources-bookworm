# ARMv7 AirPlay sender feasibility build

This recipe tests whether the pinned `airplay-cli` v0.5.2 source can produce a
native ARMv7 hard-float sender for Volumio 4. It is development tooling, not
part of plugin installation.

The script deliberately does not install packages, deploy a binary, change
Volumio configuration or modify the supplied source checkout. It builds in a
temporary directory and retains that directory whenever the build fails.

## Required environment

- Native ARMv7 Linux environment (`uname -m` reports `armv7l` or `armv8l`)
- ARM hard-float compiler (`gcc -dumpmachine` ends in `gnueabihf`)
- Git, Make, GCC, G++, binutils, `file`, Python 3 and CA certificates
- Network access when an existing complete source checkout is not supplied

Running this directly on a Volumio device is not the preferred production
build method because preparing a compiler would alter the appliance. A clean
Debian Bookworm ARMv7 container or disposable build image is preferred. The
same recipe may then be run natively inside that environment.

## Validated local build

The recipe was successfully exercised on 24 August 2026 in an emulated
`arm32v7/debian:bookworm-slim` container. The container reported `armv7l`, a
32-bit userland and Debian architecture `armhf`. GCC targeted
`arm-linux-gnueabihf`.

The pinned upstream ARM archives linked successfully, all upstream tests
passed, the sender self-check passed and the resulting ELF advertised both
ARMv7 and the hard-float VFP calling convention. The verified binary SHA-256
was:

```text
704adb5a10aa1d29c648c1b570184c09bc704ef12cb8d9581156e24dbbca01ce
```

This confirms build compatibility. It does not replace the separate gate of
running the binary and testing actual AirPlay playback on Volumio ARMv7.

## Build

```bash
./scripts/build-airplay-sender-armv7.sh \
  --output /tmp/wom-airplay-armv7-output
```

To avoid another network clone, pass a complete v0.5.2 checkout whose recursive
submodules have already been initialised:

```bash
./scripts/build-airplay-sender-armv7.sh \
  --source /path/to/airplay-cli-v0.5.2 \
  --output /tmp/wom-airplay-armv7-output
```

The recipe verifies the top-level and `libraop` revisions, selects the upstream
`linux/arm` dependency archives, builds with the Debian ARMv7 hard-float
baseline, runs upstream tests, inspects the ELF attributes and executes the
sender's self-check.

## Dependency compatibility

The initial investigation could not establish whether the upstream ARM
dependency archives used a compatible ABI. The validated build resolved this:
they link successfully into an ARMv7 hard-float executable. Rebuilding the
codec, mDNS and OpenSSL dependencies is therefore not currently necessary.

Do not deploy a result unless all tests, ELF hard-float verification and
`--check` pass. Receiver playback and stability testing remain separate gates.
