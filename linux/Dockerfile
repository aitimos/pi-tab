FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8
# Keep apt's complete dependency set on the same immutable snapshot.
RUN rm /etc/apt/sources.list.d/debian.sources && \
    printf '%s\n' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261030T000000Z bookworm main' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261030T000000Z bookworm-updates main' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20261030T000000Z bookworm-security main' \
      > /etc/apt/sources.list
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates git cmake ninja-build python3 flex bison bc rsync cpio xz-utils curl \
    && rm -rf /var/lib/apt/lists/*
RUN git config --system user.email build@pi-tab.invalid && git config --system user.name pi-tab-build
WORKDIR /build
