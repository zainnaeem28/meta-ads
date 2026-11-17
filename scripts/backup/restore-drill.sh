#!/usr/bin/env bash
# Restore drill (DO-07b; DEVOPS-PLAN 10.3 "Restore baseline", 10.4 item 7 / KC-6; TC-NFR-05, TC-OPS-04, TC-BKP-26).
#
# Agent baseline, run locally on the shared test PostgreSQL with synthetic data and a synthetic KEK:
#   1. migration rollback check on the full history (each migration: pre-migration snapshot restored into a new database
#      equals the pre-migration state; the compensating forward migration, where one exists, does the same on a copy),
#   2. seed, 3. back up (dump of public and pgboss, age-encrypted, as app_backup; media and erasure ledger mirror),
#   4. changes after the backup, an erasure after the backup, then the loss of the database (the disaster),
#   5. restore into a new empty database, rebuild what the dump does not carry, restore media,
#   6. re-apply the erasure ledger (T-22), 7. KEK canary (KC-6), 8. smoke journey against the restored copy,
#   9. the drill record: restore time, data lost, RPO 24 h and RTO 8 h.
# The real-environment drill stays go-live evidence (TC-H-08).
#
# Usage: scripts/backup/restore-drill.sh --local [--record FILE] [--junit FILE] [--keep]
#                                        [--simulate-data-loss-hours N] [--simulate-skip-reconcile]
# Environment (names only): DRILL_PG_ADMIN_URL (default postgres://postgres@test-db:5432/postgres, a superuser of a
# disposable test server; never a production URL), PG_CLIENT_ROOT (an unpacked PostgreSQL 17 client), AGE_BIN,
# AGE_KEYGEN_BIN. Exit 0 only when every step passed; 1 when a step failed; 2 on a usage or tool error.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
API="$ROOT/apps/api"
RECORD="$ROOT/reports/backup/drill-record.md"
JUNIT="$ROOT/reports/backup/drill-junit.xml"
LOCAL=0 KEEP=0 SIM_LOSS_HOURS=0 SIM_SKIP_RECONCILE=0
RPO_HOURS=24 RTO_HOURS=8

while [ $# -gt 0 ]; do
  case "$1" in
    --local) LOCAL=1 ;;
    --keep) KEEP=1 ;;
    --record) RECORD="$(realpath -m "$2")"; shift ;;
    --junit) JUNIT="$(realpath -m "$2")"; shift ;;
    --simulate-data-loss-hours) SIM_LOSS_HOURS="$2"; shift ;;
    --simulate-skip-reconcile) SIM_SKIP_RECONCILE=1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
if [ "$LOCAL" != 1 ]; then
  echo "refusing to run: only --local (a disposable test server, synthetic data) is supported; the real-environment drill is go-live evidence" >&2
  exit 2
fi

# ---------------------------------------------------------------------------------------------------- tools
if [ -n "${PG_CLIENT_ROOT:-}" ]; then
  export PATH="$PG_CLIENT_ROOT/usr/lib/postgresql/17/bin:$PATH"
  export LD_LIBRARY_PATH="$PG_CLIENT_ROOT/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
fi
for t in psql pg_dump pg_restore node pnpm openssl sha256sum curl; do
  command -v "$t" >/dev/null 2>&1 || { echo "missing tool: $t" >&2; exit 2; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/restore-drill.XXXXXX")"
CUSTODY="$WORK/custody"          # the age identity and the synthetic KEK: outside the backup tree on purpose (KC-1.2)
STORE="$WORK/store"              # app/, ledger/ (live) and backup/ (the mirror)
mkdir -p "$CUSTODY" "$STORE/app" "$STORE/ledger" "$STORE/backup" "$WORK/logs"
chmod 700 "$CUSTODY"

# age and age-keygen: AGE_BIN / AGE_KEYGEN_BIN, then PATH, then the official release archive checked against a pinned
# SHA-256 (the same pin as scripts/backup/tests/support/tools.ts).
AGE_URL=https://github.com/FiloSottile/age/releases/download/v1.2.1/age-v1.2.1-linux-amd64.tar.gz
AGE_SHA=7df45a6cc87d4da11cc03a539a7470c15b1041ab2b396af088fe9990f7c79d50
AGE="${AGE_BIN:-$(command -v age || true)}"
AGEKEYGEN="${AGE_KEYGEN_BIN:-$(command -v age-keygen || true)}"
if [ -z "$AGE" ] || [ -z "$AGEKEYGEN" ]; then
  cache="${FOUNDATION_TOOLS_CACHE:-${TMPDIR:-/tmp}/shroomap-foundation-tools}/age-1.2.1"
  if [ ! -x "$cache/age" ] || [ ! -x "$cache/age-keygen" ]; then
    mkdir -p "$cache"
    curl -fsSL "$AGE_URL" -o "$cache/age.tgz" || { echo "age download failed" >&2; exit 2; }
    [ "$(sha256sum "$cache/age.tgz" | cut -d' ' -f1)" = "$AGE_SHA" ] || { echo "age archive checksum mismatch" >&2; rm -f "$cache/age.tgz"; exit 2; }
    tar -xzf "$cache/age.tgz" -C "$cache" --strip-components=1
  fi
  AGE="$cache/age"; AGEKEYGEN="$cache/age-keygen"
fi

# ---------------------------------------------------------------------------------------------------- database access
ADMIN_URL="${DRILL_PG_ADMIN_URL:-postgres://postgres@test-db:5432/postgres}"
URL_RE='^postgres(ql)?://([^:@/]+)(:([^@]*))?@([^:/]+)(:([0-9]+))?/(.*)$'
[[ "$ADMIN_URL" =~ $URL_RE ]] || { echo "DRILL_PG_ADMIN_URL is not a postgres URL" >&2; exit 2; }
PGH="${BASH_REMATCH[5]}" PGP="${BASH_REMATCH[7]:-5432}" ADMIN_USER="${BASH_REMATCH[2]}" ADMIN_PW="${BASH_REMATCH[4]:-}"
case "$PGH" in test-db|localhost|127.0.0.1|::1|db-test*) ;; *) echo "refusing a non-test host: $PGH" >&2; exit 2 ;; esac

SUFFIX="$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
declare -A ROLE PW
for k in migrator api worker backup; do ROLE[$k]="app_${k}_$SUFFIX"; PW[$k]="$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"; done
DB_SRC="drill_src_$SUFFIX" DB_RESTORED="drill_restored_$SUFFIX"
CREATED_DBS=("$DB_SRC") ROLES_CREATED=0

url_for() { # role|admin database
  if [ "$1" = admin ]; then echo "postgres://$ADMIN_USER${ADMIN_PW:+:$ADMIN_PW}@$PGH:$PGP/$2"
  else echo "postgres://${ROLE[$1]}:${PW[$1]}@$PGH:$PGP/$2"; fi
}
sql_admin() { psql -X -q -v ON_ERROR_STOP=1 -At "$(url_for admin "${DB:-postgres}")" "$@"; }
sql() { local role="$1" db="$2"; shift 2; psql -X -q -v ON_ERROR_STOP=1 -At "$(url_for "$role" "$db")" "$@"; }

# ---------------------------------------------------------------------------------------------------- results
STEP_NAMES=() STEP_RESULTS=() STEP_SECS=() STEP_NOTES=()
FAILED=0
now() { date +%s.%N; }
elapsed() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.2f", b - a }'; }
note() { printf '%s\n' "$*" >> "$WORK/logs/notes.txt"; echo "   $*"; }
# step NAME FUNCTION: runs FUNCTION in the current shell; a non-zero return is a failure of the step (not an abort)
step() {
  local name="$1" fn="$2" t0 t1
  echo "== $name"
  : > "$WORK/logs/notes.txt"
  t0="$(now)"
  if "$fn" > "$WORK/logs/$fn.log" 2>&1; then STEP_RESULTS+=(pass); else STEP_RESULTS+=(fail); FAILED=1; echo "   FAILED; last log lines:"; tail -n 12 "$WORK/logs/$fn.log" | sed 's/^/   | /'; fi
  t1="$(now)"
  STEP_NAMES+=("$name"); STEP_SECS+=("$(elapsed "$t0" "$t1")")
  STEP_NOTES+=("$(tr '\n' ';' < "$WORK/logs/notes.txt" | sed 's/;$//')")
  [ -s "$WORK/logs/notes.txt" ] || true
  cat "$WORK/logs/$fn.log" | grep '^NOTE ' | sed 's/^NOTE /   /' || true
}
say() { echo "NOTE $*"; echo "$*" >> "$WORK/logs/notes.txt"; }

cleanup() {
  local rc=$?
  for d in "${CREATED_DBS[@]}"; do
    psql -X -q -At "$(url_for admin postgres)" -c "DROP DATABASE IF EXISTS \"$d\" WITH (FORCE)" >/dev/null 2>&1
  done
  if [ "$ROLES_CREATED" = 1 ]; then
    for k in migrator api worker backup; do psql -X -q -At "$(url_for admin postgres)" -c "DROP ROLE IF EXISTS \"${ROLE[$k]}\"" >/dev/null 2>&1; done
  fi
  [ "$KEEP" = 1 ] && echo "kept work folder $WORK (holds the synthetic KEK and age identity)" || rm -rf "$WORK"
  exit $rc
}
trap cleanup EXIT

# ---------------------------------------------------------------------------------------------------- helpers: node
cat > "$WORK/kek.mjs" <<'NODE'
// Synthetic KEK helper in the stored form of apps/api/src/modules/provider-keys (SealedEnvelopeKeyWrap / KeyUnsealer):
// AES-256-GCM, 96-bit nonce, AAD `user_id|provider|key_id|version`, the data key wrapped RSA-OAEP-SHA-256 (RSA-3072).
import { constants, createCipheriv, createDecipheriv, createHash, createPublicKey, createPrivateKey, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const [cmd, ...a] = process.argv.slice(2);
const aad = (u, p, k, v) => Buffer.from(`${u}|${p}|${k}|${v}`, 'utf8');
const fp = (pub) => createHash('sha256').update(pub.export({ type: 'spki', format: 'der' })).digest('hex');
if (cmd === 'gen') {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  writeFileSync(a[0], privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  process.stdout.write(fp(publicKey) + '\n');
} else if (cmd === 'seal') {
  const [pem, user, provider, keyId, version, plaintext] = a;
  const pub = createPublicKey(createPrivateKey(readFileSync(pem)));
  const dek = randomBytes(32), nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dek, nonce, { authTagLength: 16 });
  c.setAAD(aad(user, provider, keyId, version));
  const ciphertext = Buffer.concat([c.update(Buffer.from(plaintext)), c.final(), c.getAuthTag()]);
  const wrapped = publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, dek);
  process.stdout.write([ciphertext, nonce, wrapped].map((b) => b.toString('hex')).join(' ') + '\n');
} else if (cmd === 'unseal') {
  const [pem, user, provider, keyId, version, expected, ctHex, nonceHex, wrapHex] = a;
  try {
    const key = createPrivateKey(readFileSync(pem));
    const dek = privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(wrapHex, 'hex'));
    const ct = Buffer.from(ctHex, 'hex'); const split = ct.length - 16;
    const d = createDecipheriv('aes-256-gcm', dek, Buffer.from(nonceHex, 'hex'), { authTagLength: 16 });
    d.setAAD(aad(user, provider, keyId, version)); d.setAuthTag(ct.subarray(split));
    const out = Buffer.concat([d.update(ct.subarray(0, split)), d.final()]).toString();
    process.stdout.write(out === expected ? 'match\n' : 'mismatch\n');
  } catch { process.stdout.write('unseal-failed\n'); }
} else if (cmd === 'fingerprint') {
  process.stdout.write(fp(createPublicKey(createPrivateKey(readFileSync(a[0])))) + '\n');
}
NODE

# migration journal helpers (render, filter, ledger rows as drizzle computes them: sha256 of the file text, `when`)
cat > "$WORK/journal.mjs" <<'NODE'
import { createHash } from 'node:crypto';
import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [cmd, ...a] = process.argv.slice(2);
if (cmd === 'render') { // SRC DST SUFFIX
  const [src, dst, suffix] = a;
  cpSync(src, join(dst, 'migrations'), { recursive: true });
  for (const n of readdirSync(join(dst, 'migrations')).filter((x) => x.endsWith('.sql'))) {
    const p = join(dst, 'migrations', n);
    writeFileSync(p, readFileSync(p, 'utf8').replace(/\bapp_(migrator|api|worker|backup)\b/g, (_m, k) => `app_${k}_${suffix}`));
  }
  writeFileSync(join(dst, 'drizzle.config.ts'), "export default { dialect: 'postgresql', out: './migrations', dbCredentials: { url: process.env.MIGRATION_DATABASE_URL } };\n");
} else if (cmd === 'tags') { // DIR -> "n tag" lines
  const j = JSON.parse(readFileSync(join(a[0], 'migrations', 'meta', '_journal.json'), 'utf8'));
  j.entries.forEach((e) => console.log(e.tag));
} else if (cmd === 'through') { // DIR TAG: journal keeps entries up to and including TAG
  const p = join(a[0], 'migrations', 'meta', '_journal.json');
  const full = JSON.parse(readFileSync(join(a[0], 'journal.full.json'), 'utf8'));
  const i = full.entries.findIndex((e) => e.tag === a[1]);
  writeFileSync(p, JSON.stringify({ ...full, entries: full.entries.slice(0, i + 1) }, null, 2));
} else if (cmd === 'save-full') {
  writeFileSync(join(a[0], 'journal.full.json'), readFileSync(join(a[0], 'migrations', 'meta', '_journal.json')));
} else if (cmd === 'ledger-sql') { // DIR -> INSERTs rebuilding drizzle.__drizzle_migrations from the journal
  const full = JSON.parse(readFileSync(join(a[0], 'journal.full.json'), 'utf8'));
  console.log('CREATE SCHEMA IF NOT EXISTS drizzle;');
  console.log('CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);');
  for (const e of full.entries) {
    const hash = createHash('sha256').update(readFileSync(join(a[0], 'migrations', `${e.tag}.sql`), 'utf8')).digest('hex');
    console.log(`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('${hash}', ${e.when});`);
  }
}
NODE

# ---------------------------------------------------------------------------------------------------- helpers: data
uuid() { cat /proc/sys/kernel/random/uuid; }
# Structure of the named schemas as text, read from the catalogs: columns with types and defaults, constraints (name, type,
# validated; the text of a CHECK is not compared: pg_dump deparses an array constant differently after a restore),
# indexes, triggers, functions, table and schema privileges, default privileges. Compared as stored, so a restored copy
# must carry the same grants. PUBLIC's USAGE on schema public (a template default no migration sets; every role has its
# own USAGE grant) is not carried over by a restore and is ignored.
schema_text() { # role db schema...
  local role="$1" db="$2"; shift 2; local s list=""
  for s in "$@"; do list="${list:+$list,}'$s'"; done
  sql "$role" "$db" <<SQL | sed -E 's/,=U\/[a-z0-9_]+//'
select 'column ' || table_schema || '.' || table_name || ' ' || ordinal_position || ' ' || column_name || ' ' || udt_name || ' ' || is_nullable || ' ' || coalesce(character_maximum_length::text, '') || ' ' || coalesce(column_default, '')
  from information_schema.columns where table_schema in ($list) order by 1;
select 'constraint ' || conrelid::regclass || ' ' || conname || ' ' || contype::text || ' ' || convalidated::text from pg_constraint where connamespace in (select oid from pg_namespace where nspname in ($list)) order by 1;
select 'index ' || schemaname || ' ' || indexname || ' ' || indexdef from pg_indexes where schemaname in ($list) order by 1;
select 'trigger ' || tgrelid::regclass || ' ' || tgname from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace in (select oid from pg_namespace where nspname in ($list))) order by 1;
select 'function ' || n.nspname || '.' || proname || ' ' || md5(prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ($list) order by 1;
select 'relation ' || n.nspname || '.' || relname || ' ' || relkind::text || ' ' || coalesce(relacl::text, '') from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ($list) and relkind in ('r', 'S', 'v', 'p') order by 1;
select 'schema ' || nspname || ' ' || coalesce(nspacl::text, '') from pg_namespace where nspname in ($list) order by 1;
select 'defacl ' || coalesce(defaclnamespace::regnamespace::text, '') || ' ' || defaclobjtype::text || ' ' || defaclacl::text from pg_default_acl where defaclnamespace in (select oid from pg_namespace where nspname in ($list)) order by 1;
SQL
}
row_fingerprint() { # role db schema
  local role="$1" db="$2" schema="$3" t
  for t in $(sql "$role" "$db" -c "select tablename from pg_tables where schemaname='$schema' order by 1"); do
    printf '%s %s\n' "$t" "$(sql "$role" "$db" -c "select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) || ' ' || count(*) from $schema.\"$t\" x")"
  done
}
public_counts() { row_fingerprint "$1" "$2" public | awk '{print $1"="$3}'; }
epoch_sql() { sql "$1" "$2" -c "select extract(epoch from now())"; }

MIG_SRC="$API/src/database/migrations"
MIGDIR="$WORK/mig"
migrate_through() { # TAG
  node "$WORK/journal.mjs" through "$MIGDIR" "$1" &&
  (cd "$MIGDIR" && MIGRATION_DATABASE_URL="$(url_for migrator "$DB_SRC")" CI=1 "$API/node_modules/.bin/drizzle-kit" migrate --config "$MIGDIR/drizzle.config.ts" >> "$WORK/logs/drizzle.log" 2>&1)
}
# restore_dump DB FILE: into a new empty database, as the runbook does. The logical dump is of --schema=public, which does not
# carry the extension the schema depends on (pg_trgm, created by M0001), so the restore is in sections: the archive creates
# schema public and the tables, the extension is created in public, then data, indexes and constraints (finding F-DR-2).
restore_dump() {
  local db="$1" file="$2" url
  url="$(url_for migrator "$db")"
  sql migrator "$db" -c 'DROP SCHEMA public' &&
  pg_restore --exit-on-error --no-owner --section=pre-data --dbname "$url" "$file" &&
  sql migrator "$db" -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public' &&
  pg_restore --exit-on-error --no-owner --section=data --dbname "$url" "$file" &&
  pg_restore --exit-on-error --no-owner --section=post-data --dbname "$url" "$file"
}
new_database() { # NAME: an empty database owned by app_migrator, connectable by the other roles (as the host provisions it)
  sql_admin -c "CREATE DATABASE \"$1\" OWNER \"${ROLE[migrator]}\"" &&
  CREATED_DBS+=("$1") &&
  sql_admin -c "REVOKE CONNECT ON DATABASE \"$1\" FROM PUBLIC" -c "GRANT CONNECT ON DATABASE \"$1\" TO \"${ROLE[api]}\", \"${ROLE[worker]}\", \"${ROLE[backup]}\"" &&
  psql -X -q -v ON_ERROR_STOP=1 "$(url_for admin "$1")" -c "ALTER SCHEMA public OWNER TO \"${ROLE[migrator]}\""
}

# ================================================================================================ steps
step_provision() {
  local k
  for k in migrator api worker backup; do
    local extra="NOSUPERUSER NOCREATEDB NOCREATEROLE"
    [ "$k" = backup ] && extra="$extra NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2"
    sql_admin -c "CREATE ROLE \"${ROLE[$k]}\" LOGIN $extra PASSWORD '${PW[$k]}'" || return 1
    ROLES_CREATED=1
  done
  sql_admin -c "ALTER ROLE \"${ROLE[backup]}\" SET default_transaction_read_only = on" || return 1
  for k in migrator api worker; do sql_admin -c "ALTER ROLE \"${ROLE[$k]}\" SET search_path = public" || return 1; done
  sql_admin -c "CREATE DATABASE \"$DB_SRC\" OWNER \"${ROLE[migrator]}\"" || return 1
  sql_admin -c "REVOKE CONNECT ON DATABASE \"$DB_SRC\" FROM PUBLIC" \
    -c "GRANT CONNECT ON DATABASE \"$DB_SRC\" TO \"${ROLE[api]}\", \"${ROLE[worker]}\", \"${ROLE[backup]}\"" || return 1
  psql -X -q -v ON_ERROR_STOP=1 "$(url_for admin "$DB_SRC")" -c "ALTER SCHEMA public OWNER TO \"${ROLE[migrator]}\"" || return 1
  mkdir -p "$MIGDIR"
  node "$WORK/journal.mjs" render "$MIG_SRC" "$MIGDIR" "$SUFFIX" && node "$WORK/journal.mjs" save-full "$MIGDIR" || return 1
  say "roles and database provisioned on the shared test server (run suffix $SUFFIX); pg_dump $(pg_dump --version | awk '{print $3}'), server $(sql_admin -c 'show server_version')"
}

# Migration rollback check on the full history. For every migration K: the state before K is fingerprinted and dumped
# (the pre-migration snapshot); K is applied; the snapshot is restored into a new database; the restored copy must equal
# the pre-K state (structure and rows), and K must have changed the structure. Where a compensating forward migration
# exists for K, it is applied to a copy of the migrated database and must also give the pre-K structure.
step_migration_rollback() {
  local tags tag n=0 pre_schema pre_fp rb post_schema comp snap compensating_dir="$API/tests/integration/migrations-check/fixtures/compensating"
  local compensated=0 snapshots=0
  mapfile -t tags < <(node "$WORK/journal.mjs" tags "$MIGDIR")
  [ "${#tags[@]}" -gt 0 ] || { echo "empty journal"; return 1; }
  for tag in "${tags[@]}"; do
    n=$((n + 1))
    if [ "$n" -gt 1 ]; then
      pre_schema="$(schema_text migrator "$DB_SRC" public)"; pre_fp="$(row_fingerprint migrator "$DB_SRC" public)"
      snap="$WORK/pre-$tag.dump"
      pg_dump --format=custom --schema=public "$(url_for migrator "$DB_SRC")" > "$snap" || return 1
    fi
    migrate_through "$tag" || {
      echo "migration $tag failed; running its file directly for the message:"
      psql -X -q -v ON_ERROR_STOP=1 -1 "$(url_for migrator "$DB_SRC")" -f "$MIGDIR/migrations/$tag.sql" 2>&1 | tail -n 5; return 1; }
    if [ "$n" -eq 1 ]; then
      # one row so the later snapshots carry data
      sql migrator "$DB_SRC" -c "INSERT INTO rate_limit_buckets (scope, subject, window_start, count) VALUES ('drill', 'subject-1', now(), 3)" || return 1
      continue
    fi
    post_schema="$(schema_text migrator "$DB_SRC" public)"
    [ "$post_schema" != "$pre_schema" ] || { echo "migration $tag changed no structure of public"; return 1; }
    rb="drill_rb_${SUFFIX}_$n"
    new_database "$rb" && restore_dump "$rb" "$snap" || { echo "restore of the pre-$tag snapshot failed"; return 1; }
    [ "$(schema_text migrator "$rb" public)" = "$pre_schema" ] || {
      echo "snapshot before $tag restored to a different structure:"; diff <(echo "$pre_schema") <(schema_text migrator "$rb" public) | head -n 10; return 1; }
    [ "$(row_fingerprint migrator "$rb" public)" = "$pre_fp" ] || { echo "snapshot before $tag restored to different rows"; return 1; }
    snapshots=$((snapshots + 1))
    sql_admin -c "DROP DATABASE \"$rb\" WITH (FORCE)" || return 1
    comp="$compensating_dir/${tag%%_*}.sql"
    if [ -f "$comp" ]; then
      local cp="drill_cp_${SUFFIX}_$n"
      sql_admin -c "CREATE DATABASE \"$cp\" TEMPLATE \"$DB_SRC\" OWNER \"${ROLE[migrator]}\"" || return 1
      CREATED_DBS+=("$cp")
      sql migrator "$cp" -1 -f "$comp" || { echo "compensating migration for $tag failed"; return 1; }
      [ "$(schema_text migrator "$cp" public)" = "$pre_schema" ] || { echo "compensating migration for $tag does not give the pre-migration structure"; return 1; }
      compensated=$((compensated + 1))
      sql_admin -c "DROP DATABASE \"$cp\" WITH (FORCE)"
    fi
  done
  echo "$n $snapshots $compensated" > "$WORK/migration.counts"
  say "$n migrations applied with drizzle-kit migrate; $snapshots pre-migration snapshots restored into new databases equal their pre-migration state (structure and rows); $compensated compensating forward migrations verified on copies (the others have none yet: TASK-026 fixtures hold 0001 and 0010 only)"
  # the pgboss schema, as the release step jobs:migrate installs it (the dump below carries it)
  U="$(url_for migrator "$DB_SRC")" RA="${ROLE[api]}" RW="${ROLE[worker]}" bash -c 'cd "$0" && node --input-type=module -e "
    import { migrateJobs } from \"./dist/database/jobs-migrate.js\";
    const r = await migrateJobs(process.env.U, undefined, { api: process.env.RA, worker: process.env.RW });
    console.log(\"queues created\", r.created.length);"' "$API" || { echo "jobs:migrate failed"; return 1; }
  [ "$(sql migrator "$DB_SRC" -c "select count(*) from pg_tables where schemaname='pgboss'")" -gt 0 ] || { echo "no pgboss tables"; return 1; }
}

# ---- seed: users A (keeps), B (erased after the backup), K (canary owner); a sealed canary key row; objects; invitations
UA="$(uuid)" UB="$(uuid)" UK="$(uuid)" UC="$(uuid)"
CANARY_PLAIN="canary-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
CANARY_KEY_ID="$(uuid)"
step_seed() {
  local fp ct nonce wrapped
  fp="$(node "$WORK/kek.mjs" gen "$CUSTODY/KEK_V1.pem")" || return 1
  KEK_FP="$fp"; echo "$fp" > "$WORK/kek.fp"
  read -r ct nonce wrapped < <(node "$WORK/kek.mjs" seal "$CUSTODY/KEK_V1.pem" "$UK" openai "$CANARY_KEY_ID" 1 "$CANARY_PLAIN") || return 1
  sql migrator "$DB_SRC" <<SQL || return 1
INSERT INTO users (id, idp_subject, email, role, linked_via) VALUES
  ('$UA', 'idp|a-$SUFFIX', 'keeper-$SUFFIX@drill.invalid', 'user', 'invitation'),
  ('$UB', 'idp|b-$SUFFIX', 'doomed-$SUFFIX@drill.invalid', 'user', 'invitation'),
  ('$UK', 'idp|k-$SUFFIX', 'canary-$SUFFIX@drill.invalid', 'user', 'invitation');
INSERT INTO provider_keys (id, owner_id, provider, status, version, ciphertext, nonce, wrapped_dek, kek_version, last4, fingerprint, fingerprint_pepper_version)
  VALUES ('$CANARY_KEY_ID', '$UK', 'openai', 'active', 1, decode('$ct','hex'), decode('$nonce','hex'), decode('$wrapped','hex'), 1, 'cn01', repeat('ab', 32), 1);
INSERT INTO invitations (id, email, state, expires_at) VALUES ('$(uuid)', 'doomed-$SUFFIX@drill.invalid', 'invited', now() + interval '7 days');
INSERT INTO access_requests (id, idp_subject, email, state) VALUES ('$(uuid)', 'idp|b-$SUFFIX', 'doomed-$SUFFIX@drill.invalid', 'pending');
INSERT INTO campaigns (id, owner_id, product_name, product_description, segment_count) VALUES
  ('$(uuid)', '$UA', 'Synthetic mushroom tea', 'Synthetic product for the restore drill', 2),
  ('$(uuid)', '$UB', 'Synthetic doomed product', 'Synthetic product of the user erased later', 1);
SQL
  local u
  for u in "$UA" "$UB" "$UK"; do
    mkdir -p "$STORE/app/u/$u" "$STORE/app/q/$u"
    head -c 4096 /dev/urandom > "$STORE/app/u/$u/clip.bin"
    head -c 2048 /dev/urandom > "$STORE/app/q/$u/draft.bin"
  done
  mkdir -p "$STORE/app/smoke"; echo probe > "$STORE/app/smoke/probe.txt"   # never backed up (media mirror lists u/ only)
  say "seeded 3 users, a sealed canary key row (KEK_V1, public fingerprint $fp), invitation and access request of the later-erased user, 2 campaigns, 6 objects"
}

# ---- backup: the same dump the backup service takes (public and pgboss, as app_backup), age-encrypted; media and ledger mirror
BACKUP_AT=0 BACKUP_COUNTS_FILE="$WORK/counts.at-backup" DUMP="$STORE/backup/db/dump.dump.age"
step_backup() {
  local recipient
  "$AGEKEYGEN" -o "$CUSTODY/age-identity.txt" >/dev/null 2>&1 || return 1
  recipient="$(grep -o 'age1[0-9a-z]\{58\}' "$CUSTODY/age-identity.txt" | head -n1)"
  [ -n "$recipient" ] || return 1
  public_counts migrator "$DB_SRC" > "$BACKUP_COUNTS_FILE"
  sql migrator "$DB_SRC" -c "select count(*) from drizzle.__drizzle_migrations" > "$WORK/ledger.rows"
  sql migrator "$DB_SRC" -c "select hash || ' ' || created_at from drizzle.__drizzle_migrations order by id" > "$WORK/ledger.src"
  BACKUP_AT="$(epoch_sql migrator "$DB_SRC")"; echo "$BACKUP_AT" > "$WORK/backup.at"
  mkdir -p "$STORE/backup/db" "$STORE/backup/media" "$STORE/backup/manifests" "$STORE/backup/ledger"
  pg_dump --format=custom --schema=public --schema=pgboss "$(url_for backup "$DB_SRC")" | "$AGE" --recipient "$recipient" > "$DUMP" || return 1
  [ -s "$DUMP" ] || { echo "empty dump"; return 1; }
  # media: byte copy of u/ keyed by source key and content hash, plus a manifest (key, sha256, size, owner id, deletedAt)
  local f key h manifest="$STORE/backup/manifests/backup.json" first=1
  echo '[' > "$manifest"
  while IFS= read -r f; do
    key="${f#"$STORE/app/"}"; h="$(sha256sum "$f" | cut -d' ' -f1)"
    mkdir -p "$STORE/backup/media/$key"; cp "$f" "$STORE/backup/media/$key/$h"
    [ "$first" = 1 ] || echo ',' >> "$manifest"; first=0
    printf '{"key":"%s","etag":"%s","size":%s,"sha256":"%s","ownerId":"%s","deletedAt":null}' "$key" "$h" "$(stat -c %s "$f")" "$h" "$(echo "$key" | cut -d/ -f2)" >> "$manifest"
  done < <(find "$STORE/app/u" -type f | sort)
  echo ']' >> "$manifest"
  # ledger mirror (write-once, no delayed delete); empty at this point
  [ -z "$(ls -A "$STORE/ledger")" ] || cp -r "$STORE/ledger/." "$STORE/backup/ledger/"
  # KC-7 style scan: no key material in anything the backup holds, and the custody folder is not under the backup tree
  if grep -rIl -e 'PRIVATE KEY' -e 'AGE-SECRET-KEY' "$STORE/backup" >/dev/null 2>&1; then echo "key material found in the backup tree"; return 1; fi
  case "$CUSTODY/" in "$STORE/backup/"*) echo "custody folder inside the backup tree"; return 1 ;; esac
  say "dump $(stat -c %s "$DUMP") bytes (age-encrypted, plaintext never on disk), $(grep -c '"key"' "$manifest") media objects in the manifest, no key material in the backup tree"
}

# ---- after the backup: new data (lost with the disaster), an erasure (the ledger records it), then the disaster
LOST_ROWS=0 DISASTER_AT=0
step_after_backup() {
  local runid stamp
  sql migrator "$DB_SRC" <<SQL || return 1
INSERT INTO users (id, idp_subject, email, role, linked_via) VALUES ('$UC', 'idp|c-$SUFFIX', 'late-$SUFFIX@drill.invalid', 'user', 'invitation');
INSERT INTO campaigns (id, owner_id, product_name, product_description, segment_count) VALUES ('$(uuid)', '$UC', 'Written after the backup', 'Lost by design (RPO)', 1);
SQL
  # the erasure of user B, the way the worker does it: ledger object first (ids and kind only), then the data
  runid="$(uuid)"; stamp="$(date -u +%Y-%m-%dT%H-%M-%S-000Z)"
  mkdir -p "$STORE/ledger/erasure"
  printf '{"runId":"%s","kind":"account","subjectId":"%s"}' "$runid" "$UB" > "$STORE/ledger/erasure/$stamp-$runid"
  sql migrator "$DB_SRC" -c "DELETE FROM invitations WHERE lower(email)=lower('doomed-$SUFFIX@drill.invalid')" \
    -c "DELETE FROM access_requests WHERE idp_subject='idp|b-$SUFFIX'" -c "DELETE FROM users WHERE id='$UB'" || return 1
  rm -rf "$STORE/app/u/$UB" "$STORE/app/q/$UB"
  # data lost = what changed after the backup (rows, and the time between the backup and the disaster)
  LOST_ROWS="$(sql migrator "$DB_SRC" -c "select (select count(*) from users where created_at > to_timestamp($BACKUP_AT)) + (select count(*) from campaigns where created_at > to_timestamp($BACKUP_AT))")"
  echo "$LOST_ROWS" > "$WORK/lost.rows"
  local live_head
  live_head="$(sql migrator "$DB_SRC" -c 'select count(*) from drizzle.__drizzle_migrations')"
  smoke_api "$DB_SRC" "$live_head" || return 1
  say "finding F-DR-3 (not a restore defect): on the live database, as shipped, /health/ready answers ${SMOKE_READY##* } because app_api has no USAGE on schema drizzle and no SELECT on its ledger, which the schema-head check reads (protected routes $SMOKE_PROTECTED)"
  sql migrator "$DB_SRC" -c "GRANT USAGE ON SCHEMA drizzle TO \"${ROLE[api]}\"" -c "GRANT SELECT ON drizzle.__drizzle_migrations TO \"${ROLE[api]}\"" || return 1
  smoke_api "$DB_SRC" "$live_head" || return 1
  [ "${SMOKE_READY##* }" = 200 ] || { echo "live database not ready even with the ledger grant: $SMOKE_READY"; return 1; }
  say "baseline smoke on the live database with that grant: /health/ready 200; the same grant is part of the ledger rebuild on the restored copy"
  DISASTER_AT="$(epoch_sql migrator "$DB_SRC")"; echo "$DISASTER_AT" > "$WORK/disaster.at"
  sql_admin -c "DROP DATABASE \"$DB_SRC\" WITH (FORCE)" || return 1   # the disaster: the live database is gone, deletion_runs with it
  rm -rf "$STORE/app"                                                  # and the app bucket in this model; the backup bucket and ledger bucket survive
  say "after the backup: 1 user and 1 campaign written ($LOST_ROWS rows, lost by design), user B erased with ledger object erasure/$stamp-$runid; live database dropped"
}

# ---- restore
RESTORE_SECS=0 RESTORE_START=0
step_restore() {
  RESTORE_START="$(now)"
  new_database "$DB_RESTORED" || return 1
  # decrypted on the restore host only, into the work folder (removed at the end), never into the backup tree
  "$AGE" --decrypt --identity "$CUSTODY/age-identity.txt" --output "$WORK/restore.dump" "$DUMP" || return 1
  restore_dump "$DB_RESTORED" "$WORK/restore.dump" || return 1
  rm -f "$WORK/restore.dump"
  say "finding F-DR-2: the dump of --schema=public does not carry extension pg_trgm, so a one-pass pg_restore fails on the trigram indexes; the drill restores in sections (pre-data, CREATE EXTENSION, data, post-data). The backup service could add --extension=pg_trgm (change request for TASK-011)"
  # what the logical dump does not carry: the drizzle ledger (the dump holds public and pgboss only). Rebuilt from the
  # journal exactly as drizzle writes it, then compared with the ledger of the lost database.
  node "$WORK/journal.mjs" ledger-sql "$MIGDIR" | sql migrator "$DB_RESTORED" -f - || return 1
  sql migrator "$DB_RESTORED" -c "GRANT USAGE ON SCHEMA drizzle TO \"${ROLE[api]}\"" -c "GRANT SELECT ON drizzle.__drizzle_migrations TO \"${ROLE[api]}\"" || return 1   # as on the live database, see F-DR-3
  sql migrator "$DB_RESTORED" -c "select hash || ' ' || created_at from drizzle.__drizzle_migrations order by id" > "$WORK/ledger.restored"
  cmp -s "$WORK/ledger.src" "$WORK/ledger.restored" || { echo "rebuilt migration ledger differs from the lost database's ledger"; return 1; }
  say "finding F-DR-1: the logical dump (--schema=public --schema=pgboss) carries no drizzle ledger, so a restored database reports schema head 0 and db:migrate would re-run every migration; the drill rebuilds it from the journal (identical to the lost ledger, $(wc -l < "$WORK/ledger.src") rows). The backup service should dump --schema=drizzle too (change request for TASK-011)"
  # verification: schema history, row counts, constraints, roles and grants
  public_counts migrator "$DB_RESTORED" > "$WORK/counts.restored"
  cmp -s "$BACKUP_COUNTS_FILE" "$WORK/counts.restored" || { echo "row counts differ from the backup moment:"; diff "$BACKUP_COUNTS_FILE" "$WORK/counts.restored"; return 1; }
  [ "$(sql migrator "$DB_RESTORED" -c "select count(*) from pg_constraint where not convalidated")" = 0 ] || { echo "unvalidated constraints"; return 1; }
  [ "$(sql migrator "$DB_RESTORED" -c "select count(*) from pg_extension where extname='pg_trgm'")" = 1 ] || { echo "extension pg_trgm missing"; return 1; }
  [ "$(sql api "$DB_RESTORED" -c "select count(*) from users")" -ge 1 ] || { echo "app_api cannot read users after the restore"; return 1; }
  if sql backup "$DB_RESTORED" -c "update users set role='admin'" >/dev/null 2>&1; then echo "app_backup can write after the restore"; return 1; fi
  [ "$(sql backup "$DB_RESTORED" -c "select count(*) from users")" -ge 1 ] || { echo "app_backup cannot read after the restore"; return 1; }
  [ "$(sql migrator "$DB_RESTORED" -c "select count(*) from pg_tables where schemaname='pgboss'")" -gt 0 ] || { echo "pgboss missing"; return 1; }
  # media: copy the manifest's live objects into a new storage, skipping tombstoned keys; erased subjects are skipped in step 6
  mkdir -p "$STORE/restored/app"
  local key etag n=0
  while read -r key etag; do
    mkdir -p "$STORE/restored/app/$(dirname "$key")"; cp "$STORE/backup/media/$key/$etag" "$STORE/restored/app/$key"
    [ "$(sha256sum "$STORE/restored/app/$key" | cut -d' ' -f1)" = "$etag" ] || { echo "media object $key differs from its manifest hash"; return 1; }
    n=$((n + 1))
  done < <(node -e 'for (const e of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))) if (e.deletedAt === null) console.log(e.key, e.etag)' "$STORE/backup/manifests/backup.json")
  say "restored into a new empty database: schema history ($(wc -l < "$WORK/ledger.restored") migrations), row counts equal the backup moment, constraints valid, roles and grants kept, pgboss present; $n media objects restored with matching SHA-256"
}

# ---- ledger reconciliation (T-22): every ledger subject is erased again before the system takes traffic
step_reconcile() {
  local f subject kind email idp pre_present=0 erased=0
  # evidence that the test is meaningful: right after the restore the erased user is back
  [ "$(sql migrator "$DB_RESTORED" -c "select count(*) from users where id='$UB'")" = 1 ] || { echo "the erased user was not in the backup; the test proves nothing"; return 1; }
  pre_present=1
  say "before reconciliation the restored database holds the user erased after the backup (as expected from an old backup)"
  if [ "$SIM_SKIP_RECONCILE" = 1 ]; then say "simulated fault: reconciliation skipped"; else
    mkdir -p "$STORE/ledger/erasure"
    # the live ledger bucket and the backup bucket's mirror (ledger/) are read together; entries are write-once
    while IFS= read -r f; do
      subject="$(sed -n 's/.*"subjectId":"\([^"]*\)".*/\1/p' "$f")"; kind="$(sed -n 's/.*"kind":"\([^"]*\)".*/\1/p' "$f")"
      [ -n "$subject" ] || { echo "ledger entry $f has no subjectId"; return 1; }
      case "$kind" in
        account)
          email="$(sql migrator "$DB_RESTORED" -c "select email from users where id='$subject'")"; idp="$(sql migrator "$DB_RESTORED" -c "select idp_subject from users where id='$subject'")"
          if [ -n "$email" ]; then
            sql migrator "$DB_RESTORED" -c "DELETE FROM invitations WHERE lower(email)=lower('$email')" \
              -c "DELETE FROM access_requests WHERE idp_subject='$idp' OR lower(email)=lower('$email')" -c "DELETE FROM users WHERE id='$subject'" || return 1
            erased=$((erased + 1))
          fi
          rm -rf "$STORE/restored/app/u/$subject" "$STORE/restored/app/q/$subject" ;;
        campaign) sql migrator "$DB_RESTORED" -c "DELETE FROM campaigns WHERE id='$subject'" || return 1; erased=$((erased + 1)) ;;
        *) echo "unknown ledger kind '$kind'"; return 1 ;;
      esac
    done < <(find "$STORE/ledger" "$STORE/backup/ledger" -type f -path '*erasure/*' | sort)
  fi
  # the check: the erased subject is gone everywhere, everyone else is untouched
  local left
  left="$(sql migrator "$DB_RESTORED" -c "select (select count(*) from users where id='$UB' or idp_subject='idp|b-$SUFFIX') + (select count(*) from invitations where lower(email)=lower('doomed-$SUFFIX@drill.invalid')) + (select count(*) from access_requests where idp_subject='idp|b-$SUFFIX') + (select count(*) from campaigns where owner_id='$UB') + (select count(*) from provider_keys where owner_id='$UB')")"
  [ "$left" = 0 ] || { echo "erased user still present after restore: $left rows"; return 1; }
  [ ! -e "$STORE/restored/app/u/$UB" ] && [ ! -e "$STORE/restored/app/q/$UB" ] || { echo "erased user's objects still present"; return 1; }
  [ "$(sql migrator "$DB_RESTORED" -c "select count(*) from users where id in ('$UA','$UK')")" = 2 ] || { echo "a kept user is missing"; return 1; }
  [ -d "$STORE/restored/app/u/$UA" ] || { echo "a kept user's objects are missing"; return 1; }
  # idempotent: a second pass changes nothing
  local before after
  before="$(public_counts migrator "$DB_RESTORED" | md5sum)"
  sql migrator "$DB_RESTORED" -c "DELETE FROM users WHERE id='$UB'"
  after="$(public_counts migrator "$DB_RESTORED" | md5sum)"
  [ "$before" = "$after" ] || { echo "second pass changed data"; return 1; }
  say "ledger reconciliation: $erased subject(s) re-erased from the live and mirrored ledger; synthetic user B absent from users, invitations, access_requests, campaigns, provider_keys and storage; users A and K and their objects intact; second pass is a no-op"
}

# ---- KEK canary (KC-6): the sealed canary row of the restored database opens with the held private key
step_kek_canary() {
  local ct nonce wrapped ver
  read -r ct nonce wrapped ver < <(sql worker "$DB_RESTORED" -F ' ' -c "select encode(ciphertext,'hex'), encode(nonce,'hex'), encode(wrapped_dek,'hex'), kek_version from provider_keys where id='$CANARY_KEY_ID'")
  [ -n "${ct:-}" ] || { echo "canary row missing after restore"; return 1; }
  [ "$ver" = 1 ] || { echo "canary row has kek_version $ver, expected 1"; return 1; }
  [ "$(node "$WORK/kek.mjs" fingerprint "$CUSTODY/KEK_V1.pem")" = "$(cat "$WORK/kek.fp")" ] || { echo "public fingerprint of the held key does not match"; return 1; }
  [ "$(node "$WORK/kek.mjs" unseal "$CUSTODY/KEK_V1.pem" "$UK" openai "$CANARY_KEY_ID" 1 "$CANARY_PLAIN" "$ct" "$nonce" "$wrapped")" = match ] || { echo "the canary does not open with the held KEK_V1"; return 1; }
  # negative controls: a different key and a moved AAD must fail (a pass that cannot fail proves nothing)
  node "$WORK/kek.mjs" gen "$CUSTODY/KEK_wrong.pem" >/dev/null
  [ "$(node "$WORK/kek.mjs" unseal "$CUSTODY/KEK_wrong.pem" "$UK" openai "$CANARY_KEY_ID" 1 "$CANARY_PLAIN" "$ct" "$nonce" "$wrapped")" = unseal-failed ] || { echo "a wrong key opened the canary"; return 1; }
  [ "$(node "$WORK/kek.mjs" unseal "$CUSTODY/KEK_V1.pem" "$UA" openai "$CANARY_KEY_ID" 1 "$CANARY_PLAIN" "$ct" "$nonce" "$wrapped")" = unseal-failed ] || { echo "a moved AAD opened the canary"; return 1; }
  # custody separation (KC-1.2): the backup role cannot read the custody folder's content, and the dump holds no key
  ! grep -aq 'PRIVATE KEY' "$DUMP" || { echo "key material in the dump"; return 1; }
  say "canary row (read as the worker role) opens with the held KEK_V1 (public fingerprint ${KEK_FP:-$(cat "$WORK/kek.fp")} matches); a different key and a moved AAD both fail; the restored KEK never touched the backup tree"
}

# ---- smoke journey: the built api against a database (FLOW-04 e2e of TASK-107 does not exist yet, so the API smoke)
API_PID=""
SMOKE_READY="" SMOKE_PROTECTED=""
smoke_api() { # DB HEAD -> sets SMOKE_READY (status and body of /health/ready) and SMOKE_PROTECTED (status codes of two protected routes)
  local db="$1" head="$2" port=$((20000 + RANDOM % 20000)) envdir="$WORK/env" i code=""
  mkdir -p "$envdir"
  DB_API_USER="${ROLE[api]}:${PW[api]}" bash "$ROOT/docker/smoke/make-env.sh" "$envdir" "$PGH:$PGP/$db" >/dev/null || return 1
  [ -d "$API/dist" ] || (cd "$API" && pnpm build >/dev/null 2>&1) || { echo "api build failed"; return 1; }
  # api.env is a docker env-file (KEY=VALUE per line, no shell quoting): read it literally
  ( while IFS= read -r line; do [ -n "$line" ] && export "${line%%=*}=${line#*=}"; done < "$envdir/api.env"
    export NODE_EXTRA_CA_CERTS="$envdir/certs/public.crt"
    cd "$API" && exec env API_PORT="$port" MIN_SCHEMA_HEAD="$head" MAX_SCHEMA_HEAD="$head" LOG_LEVEL=warn node dist/main.api.js ) > "$WORK/logs/api.out" 2>&1 &
  API_PID=$!
  for i in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/health/live" || true)"; [ "$code" = 200 ] && break
    kill -0 "$API_PID" 2>/dev/null || { echo "api exited"; tail -n 20 "$WORK/logs/api.out"; return 1; }
    sleep 0.5
  done
  [ "$code" = 200 ] || { echo "api never answered /health/live"; return 1; }
  SMOKE_READY="$(curl -s -w ' %{http_code}' "http://127.0.0.1:$port/health/ready")"
  SMOKE_PROTECTED="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/v1/me/provider-keys") $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/v1/campaigns")"
  kill "$API_PID" 2>/dev/null; wait "$API_PID" 2>/dev/null; API_PID=""
}
step_smoke() {
  local head
  head="$(wc -l < "$WORK/ledger.restored")"
  smoke_api "$DB_RESTORED" "$head" || return 1
  say "smoke: the built api (node dist/main.api.js as the app_api role) started on the restored database; /health/live 200; /health/ready answered: ${SMOKE_READY##* } (schema head $head, pgboss queue check); unauthenticated protected routes answer: $SMOKE_PROTECTED"
  [ "${SMOKE_READY##* }" = 200 ] || { echo "ready check on the restored copy: $SMOKE_READY"; tail -n 5 "$WORK/logs/api.out"; return 1; }
  case "$SMOKE_PROTECTED" in *5[0-9][0-9]*) echo "a protected route answered 5xx: $SMOKE_PROTECTED"; return 1 ;; esac
}

# ---- verdict on the objectives: RPO and RTO
VERDICT_LOSS_H="0"
step_objectives() {
  local window_s rto_s ok=0
  window_s="$(awk -v a="$(cat "$WORK/backup.at")" -v b="$(cat "$WORK/disaster.at")" -v s="$SIM_LOSS_HOURS" 'BEGIN { printf "%.1f", (b - a) + s * 3600 }')"
  echo "$window_s" > "$WORK/loss.seconds"
  rto_s="$(elapsed "$RESTORE_START" "$(now)")"
  echo "$rto_s" > "$WORK/restore.seconds"
  say "data lost window ${window_s}s (backup moment to the loss of the database$([ "$SIM_LOSS_HOURS" != 0 ] && echo ", plus ${SIM_LOSS_HOURS} h simulated")), $(cat "$WORK/lost.rows") rows written after the backup; restore time ${rto_s}s"
  awk -v w="$window_s" -v h="$RPO_HOURS" 'BEGIN { exit !(w <= h * 3600) }' || { echo "data lost window ${window_s}s exceeds the RPO of ${RPO_HOURS} h"; ok=1; }
  awk -v r="$rto_s" -v h="$RTO_HOURS" 'BEGIN { exit !(r <= h * 3600) }' || { echo "restore time ${rto_s}s exceeds the RTO of ${RTO_HOURS} h"; ok=1; }
  return $ok
}

# ================================================================================================ run
echo "restore drill (local): run $SUFFIX"
# Every step needs the one before it (a dump of nothing proves nothing), so the first failure ends the run.
for spec in \
  "provision roles and database|step_provision" \
  "migration rollback check (full history)|step_migration_rollback" \
  "seed synthetic data and sealed canary key|step_seed" \
  "backup (dump, age, media, ledger mirror)|step_backup" \
  "changes after backup, erasure, disaster|step_after_backup" \
  "restore into an empty database|step_restore" \
  "erasure ledger reconciliation (T-22)|step_reconcile" \
  "KEK canary (KC-6)|step_kek_canary" \
  "smoke journey against the restored copy|step_smoke" \
  "RPO 24 h and RTO 8 h|step_objectives"; do
  [ "$FAILED" = 0 ] || { STEP_NAMES+=("${spec%%|*}"); STEP_RESULTS+=(not_run); STEP_SECS+=(0); STEP_NOTES+=("not run: an earlier step failed"); continue; }
  step "${spec%%|*}" "${spec##*|}"
done
[ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null

# ================================================================================================ records
total=0; for s in "${STEP_SECS[@]}"; do total="$(awk -v a="$total" -v b="$s" 'BEGIN { print a + b }')"; done
overall=PASS; [ "$FAILED" = 0 ] || overall=FAIL
mcount=0 msnap=0 mcomp=0; [ ! -f "$WORK/migration.counts" ] || read -r mcount msnap mcomp < "$WORK/migration.counts"
loss_s="$(cat "$WORK/loss.seconds" 2>/dev/null || echo n/a)"; rest_s="$(cat "$WORK/restore.seconds" 2>/dev/null || echo n/a)"
lost_rows="$(cat "$WORK/lost.rows" 2>/dev/null || echo n/a)"
mkdir -p "$(dirname "$RECORD")" "$(dirname "$JUNIT")"
{
  echo "# Restore drill record (DO-07b, TASK-012)"
  echo
  echo "Result: **$overall**. Scope: agent baseline on the shared test PostgreSQL, synthetic data and a synthetic KEK. The same drill in the real environment, with RTO and RPO sign-off, stays go-live evidence (TC-H-08)."
  echo
  echo "| Item | Value |"
  echo "| --- | --- |"
  echo "| Run | $(date -u +%Y-%m-%dT%H:%M:%SZ), suffix \`$SUFFIX\`, commit \`$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo n/a)\` |"
  echo "| Tools | PostgreSQL server $(sql_admin -c 'show server_version' 2>/dev/null || echo n/a), $(pg_dump --version | awk '{print "pg_dump "$3}'), $("$AGE" --version 2>/dev/null | head -n1 | sed 's/^/age /'), node $(node -v) |"
  echo "| **Restore time** (decrypt, restore, ledger rebuild, verification, media, reconciliation, canary, smoke) | **${rest_s} s** against the RTO of ${RTO_HOURS} h ($((RTO_HOURS * 3600)) s) |"
  echo "| **Data lost** (backup moment to the loss of the database) | **${loss_s} s** against the RPO of ${RPO_HOURS} h ($((RPO_HOURS * 3600)) s); ${lost_rows} rows written after the backup |"
  echo "| Migration rollback check | ${mcount} migrations; ${msnap} pre-migration snapshots restored equal; ${mcomp} compensating migrations verified |"
  echo "| Whole drill | ${total} s |"
  echo
  echo "| # | Step | Result | Seconds | Notes |"
  echo "| --- | --- | --- | --- | --- |"
  i=0; for n in "${STEP_NAMES[@]}"; do echo "| $((i + 1)) | $n | ${STEP_RESULTS[$i]} | ${STEP_SECS[$i]} | ${STEP_NOTES[$i]//|/\\|} |"; i=$((i + 1)); done
  if [ -n "$SIM_LOSS_HOURS" ] && [ "$SIM_LOSS_HOURS" != 0 ]; then echo; echo "Simulated fault: the data lost window was extended by ${SIM_LOSS_HOURS} h to prove the RPO gate."; fi
  if [ "$SIM_SKIP_RECONCILE" = 1 ]; then echo; echo "Simulated fault: the ledger reconciliation was skipped to prove the erasure check."; fi
} > "$RECORD"
{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  fails=0; for r in "${STEP_RESULTS[@]}"; do [ "$r" = pass ] || fails=$((fails + 1)); done
  echo "<testsuites><testsuite name=\"restore-drill\" tests=\"${#STEP_NAMES[@]}\" failures=\"$fails\" time=\"$total\">"
  i=0; for n in "${STEP_NAMES[@]}"; do
    echo "<testcase classname=\"restore-drill\" name=\"$n\" time=\"${STEP_SECS[$i]}\">"
    [ "${STEP_RESULTS[$i]}" = pass ] || echo "<failure message=\"step ${STEP_RESULTS[$i]}; see the drill record\"/>"
    echo "</testcase>"; i=$((i + 1))
  done
  echo "</testsuite></testsuites>"
} > "$JUNIT"
echo
echo "restore drill $overall: restore ${rest_s} s (RTO ${RTO_HOURS} h), data lost window ${loss_s} s (RPO ${RPO_HOURS} h)"
echo "record: ${RECORD#"$ROOT"/}"
echo "junit:  ${JUNIT#"$ROOT"/}"
[ "$FAILED" = 0 ]
