#!/usr/bin/env bash
# API contract check: contract-check.cjs (57 operations, 36 codes, 37 response schemas, 9 negative samples),
# its negative probe on mutated copies, Redocly lint, generated-output drift, typecheck and the public-surface tests.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
C="$CI_ROOT/packages/contracts"

contract_steps() {
  export NODE_PATH="$C/node_modules"
  local spec="$C/openapi.yaml" sb="$C/fixtures/shared-boundaries.v6.txt" out
  out="$(node "$CI_DIR/contract-check.cjs" "$spec" "$sb")" || { echo "$out"; echo "contract-check failed" >&2; return 1; }
  echo "$out"
  echo "$out" | grep -q '^SB operations: 57; openapi operations: 57;' || { echo "expected 57 operations" >&2; return 1; }
  echo "$out" | grep -q 'registry codes: 36; enum: 36;' || { echo "expected 36 = 36 codes" >&2; return 1; }
  echo "$out" | grep -q 'response schemas validated with samples: 37/37; negative checks: 9' || { echo "expected 37/37 and 9 negatives" >&2; return 1; }
  echo "$out" | tail -1 | grep -qx '0 problems' || return 1
  echo "contract-check: 57 operations, 36 = 36 codes, 37/37 schemas, 0 problems"

  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  # Negative probe: each mutated copy must make the same script exit 1.
  node -e "
    const yaml=require('js-yaml'),fs=require('fs');
    const s=yaml.load(fs.readFileSync(process.argv[1],'utf8'));
    const a=JSON.parse(JSON.stringify(s)); a.components.schemas.ErrorCode.enum.pop();
    fs.writeFileSync(process.argv[2]+'/removed-code.yaml',yaml.dump(a));
    const b=JSON.parse(JSON.stringify(s)); const op=Object.values(s.paths).flatMap(p=>Object.values(p)).find(o=>o&&o.responses&&o.responses['200']);
    const path=Object.keys(s.paths).find(k=>Object.values(s.paths[k]).includes(op)); const m=Object.keys(s.paths[path]).find(k=>s.paths[path][k]===op);
    b.paths[path][m].responses['418']={description:'extra response key',content:{'application/json':{schema:{type:'object'}}}};
    fs.writeFileSync(process.argv[2]+'/extra-response.yaml',yaml.dump(b));
  " "$spec" "$tmp"
  for m in removed-code extra-response; do
    if node "$CI_DIR/contract-check.cjs" "$tmp/$m.yaml" "$sb" >"$tmp/$m.out" 2>&1; then
      echo "negative probe '$m' unexpectedly passed" >&2; return 1
    fi
    echo "negative probe $m: exit 1 as required ($(tail -1 "$tmp/$m.out"))"
  done

  (cd "$C" && node_modules/.bin/redocly lint openapi.yaml --config redocly.yaml) || return 1
  (cd "$C" && node scripts/generate.mjs "$tmp/generated" >/dev/null) || return 1
  diff -r "$C/src/generated" "$tmp/generated" >/dev/null || { echo "generated files differ from a fresh run (run pnpm --filter @shroomap/contracts generate)" >&2; diff -rq "$C/src/generated" "$tmp/generated" >&2; return 1; }
  echo "drift check: generated output reproducible"
  (cd "$C" && pnpm typecheck && pnpm test) || return 1
}

run_summary contract "contract-check+redocly+orval" contract_steps
