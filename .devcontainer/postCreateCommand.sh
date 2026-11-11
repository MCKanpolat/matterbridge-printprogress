#!/usr/bin/env bash
set -euo pipefail

echo "Installing Matterbridge dev branch..."
bash .devcontainer/install-matterbridge-dev.sh

sudo mkdir -p /home/node/Matterbridge /home/node/.matterbridge /home/node/.mattercert
sudo chown -R node:node . /home/node/Matterbridge /home/node/.matterbridge /home/node/.mattercert

npm install --no-fund --no-audit
npm link matterbridge --no-fund --no-audit
npm run build
npm run add

echo "Matterbridge plugin dev container is ready."
