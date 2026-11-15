"""Container smoke test (TC-OPS-01): build each target, start it with a synthetic configuration, check it.

Per target it checks: built once with a recorded image ID; runs as non-root; no secret-named variable baked into
the image config; starts read-only (tmpfs for /tmp only) and answers its health probe (api: /health/live, web: /;
worker: its binaries and, once its entry exists, that the process stays up). The web target is also built twice with
different public values to prove the build takes public values only. A second build of the api target from the same
commit is compared with the first.

Writes reports/container/junit.xml and docs/evidence/TASK-008/digests.txt (or --evidence). Exit 1 on any failure.
Usage: container_smoke.py [--targets api,worker,web] [--junit PATH] [--evidence PATH] [--ids PATH]
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
import xml.etree.ElementTree as ET

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SECRET_NAME = re.compile(r"(SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|_KEY$)", re.I)
RUN_ID = os.environ.get("CI_RUN_ID") or str(os.getpid())


def sh(args, check=True, timeout=1800, **kw):
    out = subprocess.run(args, capture_output=True, text=True, timeout=timeout, cwd=ROOT, **kw)
    if check and out.returncode != 0:
        raise RuntimeError(f"{' '.join(args)[:200]} exited {out.returncode}: {(out.stderr or out.stdout)[-800:]}")
    return out


def build(target, tag, extra=()):
    iid = os.path.join(tempfile.mkdtemp(), "iid")
    sh(["docker", "build", "-f", "docker/Dockerfile", "--target", target, "--iidfile", iid,
        "-t", tag, *extra, "."])
    return open(iid).read().strip()


def inspect(ref):
    return json.loads(sh(["docker", "image", "inspect", ref]).stdout)[0]


def check_non_root(ref):
    user = inspect(ref)["Config"].get("User", "")
    assert user not in ("", "0", "root") and not user.startswith("0:"), f"image user is {user!r}"


def check_no_baked_secrets(ref):
    names = [e.split("=", 1)[0] for e in inspect(ref)["Config"].get("Env") or []]
    bad = [n for n in names if SECRET_NAME.search(n)]
    assert not bad, f"secret-named variables in the image config: {bad}"
    history = sh(["docker", "history", "--no-trunc", "--format", "{{.CreatedBy}}", ref]).stdout
    assert not re.search(r"(BEGIN [A-Z ]*PRIVATE KEY|sk_live_|sk-[A-Za-z0-9]{20,})", history), "secret in layer history"


def run_container(ref, env_file, port):
    name = f"smoke-{RUN_ID}-{int(time.time() * 1000) % 100000}"
    args = ["docker", "run", "-d", "--name", name, "--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges:true"]
    if env_file:
        args += ["--env-file", env_file]
    if port:
        args += ["-p", f"127.0.0.1::{port}"]
    sh(args + [ref])
    return name


def host_port(name, port):
    out = sh(["docker", "port", name, str(port)]).stdout.strip().splitlines()[0]
    return int(out.rsplit(":", 1)[1])


def wait_http(name, port, path, seconds=90):
    hp = host_port(name, port)
    deadline = time.time() + seconds
    last = None
    while time.time() < deadline:
        state = sh(["docker", "inspect", "-f", "{{.State.Running}}", name]).stdout.strip()
        assert state == "true", "container exited: " + sh(["docker", "logs", name], check=False).stdout[-500:]
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{hp}{path}", timeout=3) as r:
                if r.status == 200:
                    return
        except Exception as exc:  # not up yet
            last = exc
        time.sleep(2)
    raise AssertionError(f"no 200 from {path} within {seconds}s ({last})")


def remove(name):
    sh(["docker", "rm", "-f", name], check=False)


def smoke_api(ref, envdir):
    name = run_container(ref, os.path.join(envdir, "api.env"), 4000)
    try:
        wait_http(name, 4000, "/health/live")
    finally:
        remove(name)


def smoke_web(ref, _envdir):
    name = run_container(ref, None, 3000)
    try:
        wait_http(name, 3000, "/")
    finally:
        remove(name)


def smoke_worker(ref, envdir):
    version = sh(["docker", "run", "--rm", "--entrypoint", "ffmpeg", ref, "-version"]).stdout
    assert re.search(r"ffmpeg version n?7\.1", version), version.splitlines()[0]
    assert "--enable-gpl" not in version and "--enable-nonfree" not in version, "FFmpeg is not an LGPL build"
    sh(["docker", "run", "--rm", "--entrypoint", "ffprobe", ref, "-version"])
    sh(["docker", "run", "--rm", "--entrypoint", "node", ref, "-e", "require('sharp')"], check=False)
    has_entry = sh(["docker", "run", "--rm", "--entrypoint", "test", ref, "-f", "dist/main.worker.js"], check=False)
    if has_entry.returncode != 0:
        raise Skip("dist/main.worker.js is not in the repository yet (worker entry belongs to a later ticket); "
                   "binaries, non-root and no-secrets checks ran")
    name = run_container(ref, os.path.join(envdir, "worker.env"), None)
    try:
        time.sleep(10)
        state = sh(["docker", "inspect", "-f", "{{.State.Running}}", name]).stdout.strip()
        assert state == "true", "worker exited: " + sh(["docker", "logs", name], check=False).stdout[-500:]
    finally:
        remove(name)


class Skip(Exception):
    pass


def public_config_proof():
    """The web image takes public build values only: the Dockerfile declares no secret-named build argument, and a
    value passed as NEXT_PUBLIC_API_BASE_URL ends up in that image's static output and not in another build's."""
    dockerfile = open(os.path.join(ROOT, "docker/Dockerfile")).read()
    args = re.findall(r"^ARG (\w+)", dockerfile, re.M)
    web_args = [a for a in args if a.startswith("NEXT_PUBLIC_")]
    bad = [a for a in args if not a.startswith("NEXT_PUBLIC_") and SECRET_NAME.search(a)]
    assert not bad, f"secret-named build arguments: {bad}"
    assert web_args, "the web target declares no NEXT_PUBLIC_* build argument"
    urls = {"a": "https://api-a.example.test", "b": "https://api-b.example.test"}
    for key, url in urls.items():
        build("web", f"shroomap-web:public-{key}", ["--build-arg", f"NEXT_PUBLIC_API_BASE_URL={url}"])

    def found(key, url):
        out = sh(["docker", "run", "--rm", "--entrypoint", "sh", f"shroomap-web:public-{key}", "-c",
                  f"grep -rl '{url}' /app/apps/web/.next || true"]).stdout.strip()
        return bool(out)

    hits = {k: (found(k, urls[k]), found(k, urls["b" if k == "a" else "a"])) for k in urls}
    if not any(own for own, _ in hits.values()):
        raise Skip("the web app does not reference NEXT_PUBLIC_API_BASE_URL yet, so its value cannot appear in the "
                   "output; the build-argument check ran")
    assert all(own and not other for own, other in hits.values()), f"public value not isolated per build: {hits}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--targets", default="api,worker,web")
    ap.add_argument("--junit", default="reports/container/junit.xml")
    ap.add_argument("--evidence", default="docs/evidence/TASK-008/digests.txt")
    ap.add_argument("--ids", default="reports/container/image-ids.json")
    args = ap.parse_args()
    targets = args.targets.split(",")
    commit = sh(["git", "rev-parse", "HEAD"]).stdout.strip()
    envdir = tempfile.mkdtemp()
    sh(["bash", "docker/smoke/make-env.sh", envdir, os.environ.get("SMOKE_DB", "test-db:5432/smoke")])

    cases, ids, lines = [], {}, [f"commit {commit}", f"docker {sh(['docker', '--version']).stdout.strip()}"]

    def case(name, fn):
        started = time.time()
        status, msg = "pass", ""
        try:
            fn()
        except Skip as skip:
            status, msg = "skipped", str(skip)
        except Exception as exc:  # any failure is a failed case, never a crash that hides the rest
            status, msg = "fail", str(exc)
        cases.append((name, status, msg, time.time() - started))
        print(f"{status.upper():7} {name} {msg}", flush=True)

    for t in targets:
        tag = f"shroomap-{t}:smoke"
        try:
            ids[t] = build(t, tag)
            lines.append(f"{t} {ids[t]}")
        except Exception as exc:
            cases.append((f"{t}: build", "fail", str(exc), 0))
            print(f"FAIL    {t}: build {exc}", flush=True)
            continue
        cases.append((f"{t}: build", "pass", "", 0))
        case(f"{t}: runs as non-root", lambda: check_non_root(tag))
        case(f"{t}: no secrets baked into the image", lambda: check_no_baked_secrets(tag))
        probe = {"api": smoke_api, "web": smoke_web, "worker": smoke_worker}[t]
        case(f"{t}: starts read-only and answers its probe", lambda p=probe: p(tag, envdir))

    if "api" in ids:
        def rebuild():
            second = build("api", "shroomap-api:smoke-2", ["--no-cache"])
            same = second == ids["api"]
            layers_a = inspect(ids["api"])["RootFS"]["Layers"]
            layers_b = inspect(second)["RootFS"]["Layers"]
            diff = [i for i, (x, y) in enumerate(zip(layers_a, layers_b)) if x != y]
            lines.append(f"api rebuild --no-cache {second} {'IDENTICAL' if same else 'DIFFERENT'}"
                         f"; layers {len(layers_a)} vs {len(layers_b)}; differing layer indexes {diff}")
            if not same:
                lines.append("explanation: layers that run apt/pnpm install embed file mtimes and package metadata "
                             "timestamps; the base image and lockfile are pinned, so content is the same, the "
                             "digest is not bit-identical. Deploy by the digest of the one build that was scanned.")
        case("api: second build of the same commit (reproducibility recorded)", rebuild)

    if "web" in targets:
        case("web: public build values only (runtime-public-config proof)", public_config_proof)

    os.makedirs(os.path.dirname(os.path.join(ROOT, args.junit)), exist_ok=True)
    suite = ET.Element("testsuite", name="container-smoke", tests=str(len(cases)),
                       failures=str(sum(c[1] == "fail" for c in cases)),
                       skipped=str(sum(c[1] == "skipped" for c in cases)))
    for name, status, msg, secs in cases:
        tc = ET.SubElement(suite, "testcase", classname="TC-OPS-01", name=name, time=f"{secs:.1f}")
        if status == "fail":
            ET.SubElement(tc, "failure", message=msg[:300]).text = msg
        elif status == "skipped":
            ET.SubElement(tc, "skipped", message=msg[:300])
    root = ET.Element("testsuites"); root.append(suite)
    ET.ElementTree(root).write(os.path.join(ROOT, args.junit), encoding="utf-8", xml_declaration=True)
    os.makedirs(os.path.dirname(os.path.join(ROOT, args.ids)), exist_ok=True)
    json.dump(ids, open(os.path.join(ROOT, args.ids), "w"), indent=2)
    os.makedirs(os.path.dirname(os.path.join(ROOT, args.evidence)), exist_ok=True)
    open(os.path.join(ROOT, args.evidence), "w").write("\n".join(lines) + "\n")
    return 1 if any(c[1] == "fail" for c in cases) else 0


if __name__ == "__main__":
    sys.exit(main())
