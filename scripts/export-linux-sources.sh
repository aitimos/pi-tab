#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p linux/sources
docker run --rm \
  --mount "type=volume,src=${PI_TAB_LINUX_VOLUME:-pi-tab-linux-build},dst=/build" \
  --mount "type=bind,src=$PWD,dst=/project" \
  pi-tab-linux-builder bash -e -o pipefail -c '
    for component in upstream kernel musl busybox llvm; do
      source=/build/workspace/src/$component
      if [ "$component" = upstream ]; then source=/build/upstream; fi
      git -C "$source" archive --format=tar --prefix="$component/" HEAD | gzip -n > "/project/linux/sources/$component.tar.gz"
    done
    tar --exclude=sources --exclude=assets -czf /project/linux/sources/pi-tab-linux-integration.tar.gz -C /project linux scripts/build-linux.sh scripts/export-linux-sources.sh
    cd /project/linux/sources
    sha256sum *.tar.gz > SHA256SUMS
  '
echo 'Linux corresponding sources: linux/sources/ (includes toolchain, local patches and build scripts)'
