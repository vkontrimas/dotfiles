"""LLM daemon — polls GPU state, serves via Unix socket.

Drives `docker compose` directly against the vLLM composes in
local-llm/vllm/compose/ (dual.yml / solo.yml) — both variants serve the same
model/port, so switching is just: tear down whichever is up, bring up the
other, wait for it to report ready.

Supervised by the waybar-llm.service systemd user unit, which restarts it on
failure. The unit captures stderr in the journal; we additionally log to a file
so the daemon's own view of suspend/wake is visible even across restarts.
"""
import subprocess
import socket
import os
import sys
import fcntl
import logging
import signal
import threading
import time
from pathlib import Path

SOCK_PATH = os.path.expanduser("~/.cache/waybar-llm.sock")
LOCK_PATH = os.path.expanduser("~/.cache/waybar-llm.lock")
LOG_PATH = os.path.expanduser("~/.cache/waybar-llm.log")
ROOT_DIR = Path(__file__).resolve().parent.parent.parent / "local-llm" / "vllm"
ENV_FILE = ROOT_DIR / ".env"
COMPOSE_DIR = ROOT_DIR / "compose"
COMPOSE_FILES = {"dual": "dual.yml", "solo": "solo.yml"}
CONTAINER_PREFIXES = ("vllm-",)
READY_TIMEOUT = 600

logging.basicConfig(
    filename=LOG_PATH,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("waybar-llm")

_state = {"variant": "", "status": "unloaded"}
_switching = False  # True while a compose up/down is running
_saved_variant = ""  # variant to restore on wake; kept in memory across suspend
_lock = threading.Lock()
_singleton_fp = None  # held open for the process lifetime to keep the flock
_shutdown = False  # set by SIGTERM/SIGINT so the accept loop exits cleanly


def acquire_singleton():
    # Refuse to start a second daemon — otherwise each sway start leaks another
    # poll loop and the socket path gets reclaimed by whichever bound last.
    global _singleton_fp
    _singleton_fp = open(LOCK_PATH, "w")
    try:
        fcntl.flock(_singleton_fp.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        sys.exit(0)


def _request_shutdown(signum, _frame):
    global _shutdown
    _shutdown = True
    log.info("received signal %s, shutting down", signum)


def main():
    acquire_singleton()
    signal.signal(signal.SIGTERM, _request_shutdown)
    signal.signal(signal.SIGINT, _request_shutdown)

    if os.path.exists(SOCK_PATH):
        os.unlink(SOCK_PATH)

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCK_PATH)
    server.listen(5)
    server.settimeout(1.0)
    log.info("daemon started, listening on %s", SOCK_PATH)

    threading.Thread(target=poll_loop, daemon=True).start()

    while not _shutdown:
        try:
            conn, _ = server.accept()
        except socket.timeout:
            continue
        except OSError:
            # The listening socket itself failed — can't recover, let systemd
            # restart us rather than spin.
            log.exception("accept() failed on the listening socket")
            break

        # A single client connection must never take the daemon down: a slow
        # teardown can outlive the caller (logind forces suspend mid-teardown),
        # so by the time we reply the peer may be gone and sendall raises a
        # broken-pipe OSError. Swallow anything from one connection.
        try:
            data = conn.recv(4096).decode().strip()
            resp = handle(data)
            conn.sendall(resp.encode() + b"\n")
        except Exception:
            log.exception("error handling client request")
        finally:
            try:
                conn.close()
            except OSError:
                pass

    server.close()
    if os.path.exists(SOCK_PATH):
        os.unlink(SOCK_PATH)
    log.info("daemon stopped")


def handle(cmd):
    if cmd == "status":
        with _lock:
            v, s = _state["variant"], _state["status"]
        return f"{v}/{s}"
    elif cmd == "suspend":
        global _saved_variant
        with _lock:
            v = _state["variant"]
            # Record exactly what was running at this suspend (empty when nothing
            # is loaded). The daemon survives suspend/resume, so an in-memory note
            # is enough — and it can't go stale the way an on-disk file would.
            _saved_variant = v
        log.info("suspend requested; saved variant=%r", v)
        # A container in any state (loaded *or* still loading) pins the GPU, so
        # tear down whenever a variant is present.
        if not v:
            return "nothing to suspend"
        # Run synchronously: the caller is the sleep hook, which must block until
        # the GPU is actually released before the machine goes to sleep.
        do_suspend()
        return "ok"
    elif cmd == "wake":
        with _lock:
            variant = _saved_variant
        log.info("wake requested; restoring variant=%r", variant)
        if not variant:
            return "nothing to restore"
        threading.Thread(target=do_wake, args=(variant,), daemon=True).start()
        return "ok"
    elif cmd.startswith("toggle "):
        variant = cmd[7:]
        threading.Thread(target=do_toggle, args=(variant,), daemon=True).start()
        return "ok"
    return "unknown"


def compose(action, compose_file):
    """Run `docker compose up -d`/`down` for one of COMPOSE_FILES's files."""
    cmd = ["docker", "compose", "--env-file", str(ENV_FILE), "-f", str(COMPOSE_DIR / compose_file)]
    cmd += ["up", "-d", "--remove-orphans"] if action == "up" else ["down", "--remove-orphans"]
    return subprocess.run(
        cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=900
    )


def down_all():
    for compose_file in COMPOSE_FILES.values():
        compose("down", compose_file)


def wait_ready(container, timeout=READY_TIMEOUT):
    deadline = time.time() + timeout
    port = None
    while time.time() < deadline:
        state = run(["docker", "inspect", "-f", "{{.State.Running}}", container]).strip()
        if state != "true":
            log.error("container %s is not running while waiting for ready", container)
            return False
        if port is None:
            port = get_port(container)
        if port and is_serving(port):
            return True
        time.sleep(4)
    log.error("timed out waiting for %s to become ready", container)
    return False


def do_toggle(variant):
    global _switching

    with _lock:
        active = _state["variant"]
        _switching = True

    turning_off = active == variant
    topology = variant.rsplit("/", 1)[-1]

    with _lock:
        _state["variant"] = "" if turning_off else variant
        _state["status"] = "unloaded" if turning_off else "loading"

    down_all()

    ok = turning_off
    if not turning_off:
        compose_file = COMPOSE_FILES.get(topology)
        if compose_file is None:
            log.error("unknown variant %r", variant)
        else:
            ret = compose("up", compose_file)
            if ret.returncode == 0:
                ok = wait_ready(f"vllm-qwen36-27b-{topology}")

    with _lock:
        _switching = False
        if turning_off:
            _state["variant"] = ""
            _state["status"] = "unloaded"
        else:
            _state["status"] = "loaded" if ok else "error"
    log.info("toggle %r done (ok=%s)", variant, ok)


def do_suspend():
    global _switching

    with _lock:
        _switching = True

    log.info("teardown: bringing down all compose variants")
    down_all()

    with _lock:
        _switching = False
        _state["variant"] = ""
        _state["status"] = "unloaded"
    log.info("teardown complete")


def do_wake(variant):
    global _switching

    with _lock:
        _switching = True

    topology = variant.rsplit("/", 1)[-1]
    compose_file = COMPOSE_FILES.get(topology)
    log.info("wake: bringing up %s", variant)
    ret = compose("up", compose_file) if compose_file else None

    with _lock:
        _switching = False
        _state["variant"] = variant
        _state["status"] = "loading" if (ret and ret.returncode == 0) else "error"
    log.info("wake %r started (rc=%s)", variant, ret.returncode if ret else None)


def poll_loop():
    while True:
        try:
            variant, status = detect()
            with _lock:
                if not _switching:
                    _state["variant"] = variant
                    _state["status"] = status
        except Exception:
            log.debug("poll iteration failed", exc_info=True)
        time.sleep(5)


def detect():
    name = find_container()
    if not name:
        return "", "unloaded"

    variant = variant_of(name)
    port = get_port(name)
    if port and is_serving(port):
        return variant, "loaded"
    return variant, "loading"


def find_container():
    out = run(["docker", "ps", "--format", "{{.Names}}"])
    for c in out.splitlines():
        if c.startswith(CONTAINER_PREFIXES):
            return c
    return ""


def variant_of(name):
    if "dual" in name:
        return "vllm/dual"
    if "solo" in name:
        return "vllm/solo"
    return ""


def get_port(name):
    out = run(["docker", "port", name, "8000"])
    if not out:
        return None
    return out.strip().split(":")[-1]


def is_serving(port):
    try:
        ret = subprocess.run(
            ["curl", "-sf", "--max-time", "2", f"http://localhost:{port}/v1/models"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
        return ret.returncode == 0
    except Exception:
        return False


def run(cmd):
    try:
        return subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True)
    except subprocess.CalledProcessError:
        return ""


if __name__ == "__main__":
    main()
