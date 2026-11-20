#!/usr/bin/env bash
# Builds the installable zip for the Chrome extension.
# Usage: scripts/package.sh   ->   dist/silpo-price-calculator-<version>.zip
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(node -p "require('./manifest.json').version")
pkg_version=$(node -p "require('./package.json').version")
if [ "$version" != "$pkg_version" ]; then
  echo "Version mismatch: manifest.json has $version, package.json has $pkg_version" >&2
  exit 1
fi

name="silpo-price-calculator-$version"
rm -rf dist
mkdir -p "dist/$name"
cp -r manifest.json src icons LICENSE "dist/$name/"
(cd dist && zip -qr "$name.zip" "$name")
rm -rf "dist/$name"
echo "dist/$name.zip"
