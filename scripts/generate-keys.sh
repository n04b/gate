#!/bin/sh
# Generates the RS256 key pair used to issue and validate Gate JWTs.
#
#   sh scripts/generate-keys.sh [output-dir]
#
# The private key never belongs in the Docker image — keep it in the
# bind-mounted ./keys directory only.
set -eu

DIR="${1:-./keys}"
PRIVATE="$DIR/jwt_private.pem"
PUBLIC="$DIR/jwt_public.pem"

mkdir -p "$DIR"

if [ -f "$PRIVATE" ]; then
  echo "refusing to overwrite existing key: $PRIVATE" >&2
  exit 1
fi

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$PRIVATE" >/dev/null 2>&1
chmod 600 "$PRIVATE"
openssl rsa -in "$PRIVATE" -pubout -out "$PUBLIC" >/dev/null 2>&1
chmod 644 "$PUBLIC"

echo "wrote $PRIVATE"
echo "wrote $PUBLIC"
