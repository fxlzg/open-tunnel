#!/usr/bin/env bash
cd "$(dirname "$0")"
if [ -z "$1" ]; then
  node index.js --open
else
  node index.js --port "$1" --open
fi
