#!/bin/bash
set -euo pipefail
export REAL_LLVM=/build/workspace/install/llvm/bin
sysroot=/build/workspace/install/musl-wasm32_nommu
compiler=/build/upstream/tools/fake-llvm/clang
mkdir -p /build/overlay/sbin /project/linux/assets
"$compiler" --target=wasm-linux-musl -march=wasm32 -fPIC -O2 -Wframe-larger-than=2048 -Werror=frame-larger-than --sysroot="$sysroot" \
  /project/linux/bridge.c -o /build/overlay/sbin/pi-bridge -Wl,-shared -lc --rtlib=compiler-rt
cp /project/linux/init /build/overlay/init
chmod +x /build/overlay/init /build/overlay/sbin/pi-bridge
gzip -dc /build/workspace/install/initramfs-wasm32_nommu/initramfs.cpio.gz > /build/pi-tab-initramfs.cpio
cd /build/overlay
find . -print0 | cpio --null -o --format=newc -A -O /build/pi-tab-initramfs.cpio
gzip -n -c /build/pi-tab-initramfs.cpio > /project/linux/assets/initramfs.cpio.gz
cp /build/workspace/install/kernel-wasm32_nommu/vmlinux.wasm /project/linux/assets/vmlinux.wasm
cp /build/workspace/src/kernel/COPYING /project/linux/assets/KERNEL-COPYING
cp /build/workspace/src/kernel/LICENSES/preferred/GPL-2.0 /project/linux/assets/GPL-2.0
cp /build/workspace/src/musl/COPYRIGHT /project/linux/assets/MUSL-COPYRIGHT
cp /build/workspace/src/busybox/LICENSE /project/linux/assets/BUSYBOX-LICENSE
python3 - <<'PY'
import hashlib, json
from pathlib import Path
root=Path('/project/linux')
files={str(path.relative_to(root)):hashlib.sha256(path.read_bytes()).hexdigest()
       for folder in ['assets','vendor','patches'] for path in sorted((root/folder).glob('*')) if path.is_file()}
for name in ['bridge.c','init','versions.env','Dockerfile','build-system.sh','build-resources.sh','runtime.patch']:
    files[name]=hashlib.sha256((root/name).read_bytes()).hexdigest()
versions=dict(line.split('=',1) for line in (root/'versions.env').read_text().splitlines() if '=' in line)
(root/'resources.json').write_text(json.dumps({'variant':'wasm32_nommu','versions':versions,'sha256':files},indent=2)+'\n')
PY
