#!/usr/bin/env bash
set -euo pipefail

cd /
test -d /matterbridge
sudo chown -R node:node /matterbridge
sudo chmod g+s /matterbridge
sudo rm -rf /matterbridge/* /matterbridge/.[!.]* /matterbridge/..?*
git clone --depth 1 --single-branch --no-tags -b dev https://github.com/Luligu/matterbridge.git /matterbridge
cd /matterbridge

SHA7=$(git rev-parse --short=7 HEAD)
BASE_VERSION=$(node -p "require('./package.json').version.split('-')[0]")
npm pkg set version="${BASE_VERSION}-git-${SHA7}"
npm ci --no-fund --no-audit
npm run build
cd apps/frontend
npm ci --no-fund --no-audit
npm run build
cd ../..
npm install . --global --no-fund --no-audit

rm -rf .cache .devcontainer .git .github .vscode docker docs reflector screenshots systemd
