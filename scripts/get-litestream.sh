#!/usr/bin/env bash
# Downloads Litestream (free, open source) at build time. Litestream copies
# secval's SQLite store to a free Backblaze B2 bucket and restores it on boot,
# so the allowlist, proofs and audit trail survive Render free-tier wipes.
# A failed download only skips the backup; secval itself still builds.
set -u
VERSION=v0.3.13
mkdir -p bin
curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/${VERSION}/litestream-${VERSION}-linux-amd64.tar.gz" \
  | tar -xz -C bin litestream \
  && echo "litestream ${VERSION} installed" \
  || echo "WARNING: litestream download failed; data will not be backed up"
