#!/usr/bin/env bash

set -ueo pipefail

# The variant selects which xsnap train's binary to interrogate: 'legacy' (the
# default, the snapshot-compatible engine in the unprefixed tree) or 'latest'
# (the upgrade-capable engine under the parallel latest/ tree). See
# resolveXsnapWorkerPath in src/xsnap.js for the matching path split.
variant="${1:-legacy}"
case "${variant}" in
  legacy) prefix="" ;;
  latest) prefix="latest/" ;;
  *) echo "get_xsnap_version.sh: unknown variant '${variant}'" >&2; exit 2 ;;
esac

# the xsnap binary lives in a platform-specific directory
unameOut="$(uname -s)"
case "${unameOut}" in
  Linux*) platform=lin ;;
  Darwin*) platform=mac ;;
  *) platform=win ;;
esac

# extract the xsnap package version from the long version printed by xsnap-worker
"./${prefix}xsnap-native/xsnap/build/bin/${platform}/release/xsnap-worker" -v | sed -e 's/^xsnap \([^ ]*\) (XS [^)]*)$/\1/g'
