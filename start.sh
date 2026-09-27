#!/bin/sh

set -e

echo "Starting Telegram Local Bot API..."

telegram-bot-api \
  --local \
  --http-port=8081 \
  --dir=/data \
  --temp-dir=/data/temp &

echo "Starting CDN proxy..."

node /app/blitz-cdn-proxy.js &

echo "Starting public router..."

node /app/server.js &

wait
