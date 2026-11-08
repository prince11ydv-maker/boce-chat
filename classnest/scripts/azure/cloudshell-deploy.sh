#!/usr/bin/env bash
set -euo pipefail
# Run only in the reviewed user's authenticated ephemeral Azure Cloud Shell.
# --apply is a separate, explicit step after read-only preflight and access approval.
# No password or token is supplied on command lines or written by this wrapper.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python3 -m pip install --disable-pip-version-check -r "$script_dir/requirements.txt" --quiet
exec python3 "$script_dir/cloudshell-deploy.py" "$@"
