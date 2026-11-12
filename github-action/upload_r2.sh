#!/usr/bin/env bash
# Upload a data file straight into the app's Cloudflare R2 bucket, so the app keeps
# getting fresh stats when this GitHub repo is private (the app can't read private
# raw.githubusercontent.com links).
#
#   github-action/upload_r2.sh <file> <key in R2> [--stamp]
#
# Needs these repository secrets (Settings > Secrets and variables > Actions):
#   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY  an R2 API token with Object Read & Write on the bucket
#   CLOUDFLARE_ACCOUNT_ID                    your Cloudflare account ID
# Optional repository variable R2_BUCKET (default nfl-prop-data).
# Without the secrets it prints a note and exits 0, so public-repo setups keep working.
# --stamp adds _pulledAt (used for the injury report's freshness check).
set -euo pipefail
src="$1"; key="$2"; stamp="${3:-}"
if [ -z "${R2_ACCESS_KEY_ID:-}" ] || [ -z "${R2_SECRET_ACCESS_KEY:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "R2 upload skipped for $key (R2 secrets not set)"; exit 0
fi
if [ ! -s "$src" ]; then echo "R2 upload skipped: $src is missing or empty" >&2; exit 1; fi
# Same check the app does before trusting a feed: valid JSON with a players list.
python3 - "$src" "$stamp" <<'PY'
import json, sys, datetime
path, stamp = sys.argv[1], sys.argv[2]
with open(path) as f: data = json.load(f)
if not isinstance(data, dict) or not isinstance(data.get("players"), list):
    sys.exit(f"{path}: not a feed file (no players list); not uploading")
if stamp == "--stamp":
    data["_pulledAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with open(path + ".r2", "w") as f: json.dump(data, f)
PY
up="$src"; [ "$stamp" = "--stamp" ] && up="$src.r2"
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=auto
# R2 doesn't need the newer default checksums some AWS CLI versions send.
export AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED
aws s3 cp "$up" "s3://${R2_BUCKET:-nfl-prop-data}/$key" --content-type application/json \
  --endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com" --only-show-errors
rm -f "$src.r2"
echo "Uploaded $key to R2"
