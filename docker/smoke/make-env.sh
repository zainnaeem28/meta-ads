#!/usr/bin/env bash
# Writes a complete, valid SYNTHETIC configuration for the api and worker processes (throwaway keys generated now,
# nothing real) into OUT_DIR as api.env and worker.env. Used by the container smoke test and docker/compose.ci.yml.
# Usage: make-env.sh OUT_DIR DATABASE_HOST_PORT_DB   e.g. make-env.sh /tmp/x test-db:5432/app_ci_1
set -euo pipefail
out="${1:?output directory}"; db="${2:?host:port/database of the shared test PostgreSQL}"
mkdir -p "$out"; umask 077
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$tmp/priv.pem" 2>/dev/null
openssl pkey -in "$tmp/priv.pem" -pubout -out "$tmp/pub.pem"
# The config schema requires an https R2_ENDPOINT, so the CI MinIO serves TLS with a throwaway certificate (SAN minio).
mkdir -p "$out/certs"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=minio" -addext "subjectAltName=DNS:minio,DNS:localhost" \
  -keyout "$out/certs/private.key" -out "$out/certs/public.crt" 2>/dev/null
chmod 644 "$out/certs/private.key" "$out/certs/public.crt"   # throwaway, read by the non-root minio and node users
json_pem() { python3 -I -c 'import json,sys; print(json.dumps({"1": open(sys.argv[1]).read()}))' "$1"; }
b64() { head -c 32 /dev/urandom | base64; }
common=$(cat <<ENV
APP_ENV=development
KEK_PUBLIC_KEYS=$(json_pem "$tmp/pub.pem" | tr -d '\n')
KEK_ACTIVE_VERSION=1
R2_ENDPOINT=https://minio:9000
NODE_EXTRA_CA_CERTS=/certs/public.crt
R2_BUCKET=app
R2_ACCESS_KEY_ID=${MINIO_ROOT_USER:-shroomap-local}
R2_SECRET_ACCESS_KEY=${MINIO_ROOT_PASSWORD:-shroomap-local-secret}
CLERK_SECRET_KEY=sk_test_synthetic
ENV
)
{
  echo "$common"
  echo "DATABASE_URL=postgres://${DB_API_USER:-postgres}@${db}"
  echo "WEB_ORIGIN=http://localhost:3000"
  echo "CLERK_JWT_ISSUER=https://clerk.example.test"
  echo "KEY_FINGERPRINT_PEPPERS={\"1\":\"$(b64)\"}"
  echo "KEY_FINGERPRINT_PEPPER_ACTIVE=1"
  echo "RATE_LIMIT_IP_KEY=$(head -c 30 /dev/urandom | base64 | tr -d '\n=+/')"
  echo "CURSOR_SIGNING_KEY=$(head -c 30 /dev/urandom | base64 | tr -d '\n=+/')"
} > "$out/api.env"
{
  echo "$common"
  echo "DATABASE_URL=postgres://${DB_WORKER_USER:-postgres}@${db}"
  echo "KEK_PRIVATE_KEYS=$(json_pem "$tmp/priv.pem" | tr -d '\n')"
  echo "R2_LEDGER_BUCKET=ledger"
  echo "R2_LEDGER_ACCESS_KEY_ID=${MINIO_ROOT_USER:-shroomap-local}"
  echo "R2_LEDGER_SECRET_ACCESS_KEY=${MINIO_ROOT_PASSWORD:-shroomap-local-secret}"
} > "$out/worker.env"
echo "wrote $out/api.env and $out/worker.env (synthetic)"
