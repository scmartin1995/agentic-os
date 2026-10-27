#!/bin/bash
# Starts Agentic OS on a Mac. In Terminal, in this folder:   bash start-mac.sh
# The first run installs what Agentic OS needs (a minute or two), then opens the window.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Agentic OS needs Node.js 20 or newer. Install the LTS version from https://nodejs.org, then run this again."
  exit 1
fi
major=$(node -p "process.versions.node.split('.')[0]")
if [ "$major" -lt 20 ]; then
  echo "This is Node $major. Agentic OS needs Node 20 or newer (https://nodejs.org)."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing the assistant's parts (first run only)..."
  npm install || { echo "npm install failed. See the message above."; exit 1; }
fi
npm start
