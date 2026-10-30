#!/bin/bash
set -euo pipefail
source /project/linux/versions.env
if [ -f /build/versions.env ] && ! cmp -s /build/versions.env /project/linux/versions.env; then
  echo 'Linux source versions changed. Set PI_TAB_LINUX_VOLUME to a new cache volume.' >&2
  exit 1
fi
cp /project/linux/versions.env /build/versions.env
export LW_WORKSPACE=/build/workspace LW_VARIANT=wasm32_nommu
export CMAKE_BUILD_PARALLEL_LEVEL=8 LW_JOBS_LLVM_COMPILE=8 LW_JOBS_LLVM_LINK=1
export LW_JOBS_KERNEL_COMPILE=8 LW_JOBS_MUSL_COMPILE=8 LW_JOBS_BUSYBOX_COMPILE=8
export LW_KERNEL_CONFIG=
checkout() {
  local url=$1 revision=$2 directory=$3
  if [ ! -d "$directory/.git" ]; then
    git init "$directory"
    git -C "$directory" remote add origin "$url"
  fi
  if ! git -C "$directory" rev-parse --verify HEAD >/dev/null 2>&1; then
    git -C "$directory" fetch --depth 1 origin "$revision"
    git -C "$directory" checkout --detach FETCH_HEAD
  fi
}
checkout https://github.com/joelseverin/linux-wasm.git "$LINUX_WASM_REV" /build/upstream
mkdir -p "$LW_WORKSPACE/src"
checkout https://github.com/joelseverin/llvm.git "$LLVM_REV" "$LW_WORKSPACE/src/llvm"
checkout https://github.com/joelseverin/linux.git "$KERNEL_REV" "$LW_WORKSPACE/src/kernel"
checkout https://git.musl-libc.org/git/musl "$MUSL_REV" "$LW_WORKSPACE/src/musl"
checkout https://git.busybox.net/busybox "$BUSYBOX_REV" "$LW_WORKSPACE/src/busybox"
for component in musl busybox; do
  if [ ! -f "$LW_WORKSPACE/src/$component/.pi-tab-patched" ]; then
    git -C "$LW_WORKSPACE/src/$component" am /build/upstream/patches/"$component"/*.patch
    touch "$LW_WORKSPACE/src/$component/.pi-tab-patched"
  fi
done
if ! git -C "$LW_WORKSPACE/src/kernel" apply --reverse --check /project/linux/patches/0001-userspace-stack.patch 2>/dev/null; then
  git -C "$LW_WORKSPACE/src/kernel" apply /project/linux/patches/0001-userspace-stack.patch
  rm -f /build/system-ready
fi
if [ ! -f /build/toolchain-ready ]; then
  /build/upstream/linux-wasm.sh build-tools
  touch /build/toolchain-ready
fi
if [ ! -f /build/system-ready ]; then
  /build/upstream/linux-wasm.sh build-os
  touch /build/system-ready
fi
bash /project/linux/build-resources.sh
