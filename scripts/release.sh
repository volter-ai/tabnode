#!/bin/bash
# Consume an authorized retained archive; never build, version, tag or retry an upload.
set -euo pipefail
exec node "$(dirname "$0")/release-receipt.mjs" "$@"
