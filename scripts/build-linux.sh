#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker build -t pi-tab-linux-builder -f linux/Dockerfile linux
docker run --rm \
  --mount "type=volume,src=${PI_TAB_LINUX_VOLUME:-pi-tab-linux-build},dst=/build" \
  --mount "type=bind,src=$PWD,dst=/project" \
  pi-tab-linux-builder bash /project/linux/build-system.sh
