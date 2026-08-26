#!/bin/bash

set -euo pipefail

AIRPLAY_VERSION="v0.5.2"
AIRPLAY_COMMIT="43e4c33c833c1756a22feb3a5167d3112f82cce2"
LIBRAOP_COMMIT="81c2182649da8645ac2a58b78e9f370c79a4165b"
AIRPLAY_REPOSITORY="https://github.com/music-assistant/airplay-cli.git"
SOURCE_DIR=""
OUTPUT_DIR=""
KEEP_WORK=0

usage() {
  cat <<'EOF'
Build the pinned AirPlay sender for Volumio's ARMv7 hard-float platform.

Usage:
  build-airplay-sender-armv7.sh [options]

Options:
  --source DIR   Use an existing complete airplay-cli v0.5.2 checkout.
  --output DIR   Store the verified binary and build manifest in DIR.
  --keep-work    Preserve the temporary source and build directory.
  --help         Show this help.

The recipe does not install packages, modify Volumio, deploy the binary or
alter the supplied source checkout. It requires an ARMv7 hard-float build
environment with git, make, gcc, g++, binutils, file and Python 3.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source)
      [ "$#" -ge 2 ] || { echo "--source requires a directory" >&2; exit 2; }
      SOURCE_DIR="$2"
      shift 2
      ;;
    --output)
      [ "$#" -ge 2 ] || { echo "--output requires a directory" >&2; exit 2; }
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --keep-work)
      KEEP_WORK=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

for command_name in git make gcc g++ ar file readelf python3 sha256sum; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required build command: $command_name" >&2
    echo "No packages were installed. Prepare the build environment and retry." >&2
    exit 1
  fi
done

KERNEL_ARCH="$(uname -m)"
COMPILER_TARGET="$(gcc -dumpmachine 2>/dev/null || true)"
case "$KERNEL_ARCH" in
  armv7l|armv8l) ;;
  *)
    echo "This feasibility recipe must run natively in an ARMv7 environment." >&2
    echo "Detected kernel architecture: $KERNEL_ARCH" >&2
    exit 1
    ;;
esac
case "$COMPILER_TARGET" in
  arm*-linux-gnueabihf) ;;
  *)
    echo "The compiler is not targeting the ARM hard-float ABI: $COMPILER_TARGET" >&2
    exit 1
    ;;
esac

if [ -z "$OUTPUT_DIR" ]; then
  OUTPUT_DIR="$(mktemp -d /tmp/wom-airplay-armv7-output.XXXXXX)"
else
  mkdir -p "$OUTPUT_DIR"
fi
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"

WORK_DIR="$(mktemp -d /tmp/wom-airplay-armv7-build.XXXXXX)"
BUILD_LOG="$OUTPUT_DIR/build.log"
SUCCESS=0

finish() {
  status=$?
  trap - EXIT
  if [ "$SUCCESS" -eq 1 ] && [ "$KEEP_WORK" -eq 0 ]; then
    case "$WORK_DIR" in
      /tmp/wom-airplay-armv7-build.*) rm -rf "$WORK_DIR" ;;
      *) echo "Refusing to remove unexpected build path: $WORK_DIR" >&2 ;;
    esac
  else
    echo "Build workspace retained at: $WORK_DIR" >&2
  fi
  exit "$status"
}
trap finish EXIT

echo "AirPlay sender ARMv7 feasibility build" | tee "$BUILD_LOG"
echo "Kernel: $KERNEL_ARCH" | tee -a "$BUILD_LOG"
echo "Compiler target: $COMPILER_TARGET" | tee -a "$BUILD_LOG"
echo "Compiler: $(gcc --version | head -1)" | tee -a "$BUILD_LOG"
echo "Output: $OUTPUT_DIR" | tee -a "$BUILD_LOG"

if [ -n "$SOURCE_DIR" ]; then
  SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"
  echo "Copying existing source checkout: $SOURCE_DIR" | tee -a "$BUILD_LOG"
  git clone --local --no-hardlinks --recurse-submodules \
    "$SOURCE_DIR" "$WORK_DIR/airplay-cli" 2>&1 | tee -a "$BUILD_LOG"
else
  echo "Cloning pinned source release: $AIRPLAY_VERSION" | tee -a "$BUILD_LOG"
  git clone --branch "$AIRPLAY_VERSION" --depth 1 \
    --recurse-submodules --shallow-submodules \
    "$AIRPLAY_REPOSITORY" "$WORK_DIR/airplay-cli" 2>&1 | tee -a "$BUILD_LOG"
fi

BUILD_SOURCE="$WORK_DIR/airplay-cli"
git -C "$BUILD_SOURCE" submodule update --init --recursive --force \
  2>&1 | tee -a "$BUILD_LOG"

ACTUAL_COMMIT="$(git -C "$BUILD_SOURCE" rev-parse HEAD)"
ACTUAL_LIBRAOP="$(git -C "$BUILD_SOURCE/libraop" rev-parse HEAD)"
if [ "$ACTUAL_COMMIT" != "$AIRPLAY_COMMIT" ]; then
  echo "Unexpected airplay-cli commit: $ACTUAL_COMMIT" >&2
  exit 1
fi
if [ "$ACTUAL_LIBRAOP" != "$LIBRAOP_COMMIT" ]; then
  echo "Unexpected libraop commit: $ACTUAL_LIBRAOP" >&2
  exit 1
fi

for required_archive in \
  libraop/libcodecs/targets/linux/arm/libcodecs.a \
  libraop/libmdns/targets/linux/arm/libmdns.a \
  libraop/libopenssl/targets/linux/arm/libopenssl.a
do
  if [ ! -f "$BUILD_SOURCE/$required_archive" ]; then
    echo "Pinned source is missing $required_archive" >&2
    exit 1
  fi
done

SOURCE_DATE_EPOCH="$(git -C "$BUILD_SOURCE" show -s --format=%ct HEAD)"
export SOURCE_DATE_EPOCH
export LC_ALL=C
export TZ=UTC

ARM_FLAGS="-march=armv7-a -mfpu=vfpv3-d16 -mfloat-abi=hard"
JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"

echo "Building with conservative flags: $ARM_FLAGS" | tee -a "$BUILD_LOG"
echo "The first build deliberately tests the pinned upstream Linux/arm archives." \
  | tee -a "$BUILD_LOG"

cd "$BUILD_SOURCE"
make clean 2>&1 | tee -a "$BUILD_LOG"
if ! make -j"$JOBS" \
  STATIC=1 \
  HOST=linux \
  PLATFORM=arm \
  CC=gcc \
  CXX=g++ \
  VERSION="${AIRPLAY_VERSION#v}" \
  EXTRA_CFLAGS="$ARM_FLAGS" \
  EXTRA_LDFLAGS="$ARM_FLAGS" \
  2>&1 | tee -a "$BUILD_LOG"
then
  cat >&2 <<EOF

The top-level ARMv7 build failed. Inspect:
  $BUILD_LOG

If the linker reports incompatible VFP register arguments, the pinned
upstream Linux/arm archives use a different ABI and must be rebuilt with
arm-linux-gnueabihf before retrying. No plugin or system file was changed.
EOF
  exit 1
fi

BINARY="$BUILD_SOURCE/bin/cliairplay-linux-arm"
if [ ! -x "$BINARY" ]; then
  echo "The build did not produce an executable sender: $BINARY" >&2
  exit 1
fi

echo "Running upstream tests" | tee -a "$BUILD_LOG"
make test -j"$JOBS" \
  STATIC=1 \
  HOST=linux \
  PLATFORM=arm \
  CC=gcc \
  CXX=g++ \
  VERSION="${AIRPLAY_VERSION#v}" \
  EXTRA_CFLAGS="$ARM_FLAGS" \
  EXTRA_LDFLAGS="$ARM_FLAGS" \
  2>&1 | tee -a "$BUILD_LOG"

file "$BINARY" | tee -a "$BUILD_LOG"
readelf -h "$BINARY" > "$OUTPUT_DIR/readelf-header.txt"
readelf -A "$BINARY" > "$OUTPUT_DIR/readelf-attributes.txt"
if ! grep -q 'Tag_ABI_VFP_args: VFP registers' "$OUTPUT_DIR/readelf-attributes.txt"; then
  echo "Built binary does not advertise the required hard-float VFP ABI" >&2
  exit 1
fi

SELF_CHECK="$($BINARY --check 2>&1)"
printf '%s\n' "$SELF_CHECK" | tee -a "$BUILD_LOG"
if ! printf '%s\n' "$SELF_CHECK" | grep -qE 'cliairplay.*check'; then
  echo "The ARMv7 sender failed its self-check" >&2
  exit 1
fi

install -m 0755 "$BINARY" "$OUTPUT_DIR/cliairplay-linux-arm"
install -m 0644 "$BUILD_SOURCE/LICENSE" "$OUTPUT_DIR/LICENSE.cliairplay"
install -m 0644 "$BUILD_SOURCE/THIRD_PARTY_NOTICES.md" \
  "$OUTPUT_DIR/THIRD_PARTY_NOTICES.cliairplay.md"

BINARY_SHA256="$(sha256sum "$OUTPUT_DIR/cliairplay-linux-arm" | awk '{print $1}')"
cat > "$OUTPUT_DIR/BUILD-MANIFEST.txt" <<EOF
AirPlay sender version: $AIRPLAY_VERSION
airplay-cli commit: $ACTUAL_COMMIT
libraop commit: $ACTUAL_LIBRAOP
Kernel architecture: $KERNEL_ARCH
Compiler target: $COMPILER_TARGET
Compiler: $(gcc --version | head -1)
Build flags: $ARM_FLAGS
Source date epoch: $SOURCE_DATE_EPOCH
Binary SHA-256: $BINARY_SHA256
EOF

SUCCESS=1
echo "ARMv7 sender build and self-check passed." | tee -a "$BUILD_LOG"
echo "Binary: $OUTPUT_DIR/cliairplay-linux-arm" | tee -a "$BUILD_LOG"
echo "SHA-256: $BINARY_SHA256" | tee -a "$BUILD_LOG"
