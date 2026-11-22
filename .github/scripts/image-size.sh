#!/usr/bin/env bash
# Compressed size of a pushed multi-arch image, per platform and in total (unique blobs,
# which is roughly what the registry stores for it). Markdown for $GITHUB_STEP_SUMMARY.
#
#   bash .github/scripts/image-size.sh ghcr.io/<owner>/<repo>/<image> <tag>
set -euo pipefail
name=$1
tag=$2

human() { numfmt --to=iec --suffix=B --format=%.1f "$1"; }

index=$(docker buildx imagetools inspect --raw "$name:$tag")
blobs=$(mktemp)
echo "#### \`$name:$tag\`"
echo
echo "| platform | compressed |"
echo "|---|---|"
while read -r digest platform; do
  manifest=$(docker buildx imagetools inspect --raw "$name@$digest")
  jq -r '(.layers + [.config])[] | "\(.digest) \(.size)"' <<<"$manifest" >>"$blobs"
  echo "| $platform | $(human "$(jq '[(.layers + [.config])[].size] | add' <<<"$manifest")") |"
done < <(jq -r '.manifests[] | select(.platform.os != "unknown")
                | "\(.digest) \(.platform.os)/\(.platform.architecture)\(.platform.variant // "" | if . == "" then "" else "/" + . end)"' <<<"$index")
echo "| **all platforms (unique layers)** | **$(human "$(sort -u "$blobs" | awk '{s += $2} END {print s}')")** |"
echo
rm -f "$blobs"
