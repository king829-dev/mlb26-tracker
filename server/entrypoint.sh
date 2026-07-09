#!/bin/sh
set -e

CERT_DIR="${DATA_DIR:-/data}/certs"
CERT_FILE="$CERT_DIR/cert.pem"
KEY_FILE="$CERT_DIR/key.pem"

if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
  echo "No TLS cert found — generating a self-signed one (one-time, persisted in the data volume)..."
  mkdir -p "$CERT_DIR"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$KEY_FILE" -out "$CERT_FILE" \
    -subj "/CN=mlb26-tracker" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
fi

exec node server.js
