#!/usr/bin/env bash
set -euo pipefail

npm install --no-fund --no-audit
npm link matterbridge --no-fund --no-audit
npm run build
