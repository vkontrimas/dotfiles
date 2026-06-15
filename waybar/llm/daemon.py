"""LLM daemon — polls GPU state, serves via Unix socket.

Runs switch.sh directly so it knows exactly when the model transitions.
Blocks polling during active switches to avoid state flicker.
"""
import subprocess
import socket
import os
import sys
import threading
import time
from pathlib import Path

SOCK_PATH = os.path.expanduser("~/.cache/waybar-llm.sock")
SAVED_PATH = os.path.expanduser("~/.cache/llm-saved-variant")
ROOT_DIR = os.path.expanduser("~/local-llm/club-3090")
CONTAINER_PREFIXES = ("vllm-", "llama-cpp-", "beellama-", "ik-llama-", "sglang-")

_state = {"variant": "", "status": "unloaded"}
_switching = False  # True while switch.sh is running
_lock = threading.Lock()


def main():
    if os.path.exists(SOCK_PATH):
        os.unlink(SOCK_PATH)

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCK_PATH)
    server.listen(5)
    server.settimeout(1.0)

    threading.Thread(target=poll_loop, daemon=True).start()

    while True:
        try:
            conn, _ = server.accept()
            data = conn.recv(4096).decode().strip()
            resp = handle(data)
            conn.sendall(resp.encode() + b"\n")
            conn.close()
        except socket.timeout:
            continue
        except OSError:
            break

    server.close()
    if os.path.exists(SOCK_PATH):
        os.unlink(SOCK_PATH)


def handle(cmd):
    if cmd == "status":
        with _lock:
            v, s = _state["variant"], _state["status"]
        return f"{v}/{s}"
    elif cmd == "suspend":
        with _lock:
            v, s = _state["variant"], _state["status"]
        if not v or s != "loaded":
            return "nothing to suspend"
        Path(SAVED_PATH).write_text(v)
        threading.Thread(target=do_suspend, daemon=True).start()
        return "ok"
    elif cmd == "wake":
        if not os.path.exists(SAVED_PATH):
            return "nothing to restore"
        variant = Path(SAVED_PATH).read_text().strip()
        if not variant:
            return "nothing to restore"
        threading.Thread(target=do_wake, args=(variant,), daemon=True).start()
        return "ok"
    elif cmd.startswith("toggle "):
        variant = cmd[7:]
        threading.Thread(target=do_toggle, args=(variant,), daemon=True).start()
        return "ok"
    return "unknown"


def do_toggle(variant):
    global _switching

    with _lock:
        active = _state["variant"]
        _switching = True

    if active == variant:
        cmd = ["bash", f"{ROOT_DIR}/scripts/switch.sh", "--down"]
    else:
        cmd = ["bash", f"{ROOT_DIR}/scripts/switch.sh", variant]

    # Immediately set loading
    with _lock:
        _state["variant"] = variant
        _state["status"] = "loading"

    env = os.environ.copy()
    env["PATH"] = f"{ROOT_DIR}/.venv/bin:{env.get('PATH', '')}"
    ret = subprocess.run(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=env,
        timeout=900,
    )

    with _lock:
        _switching = False
        if active == variant:
            # Was toggling off
            _state["variant"] = ""
            _state["status"] = "unloaded"
        elif ret == 0:
            _state["status"] = "loaded"
        else:
            _state["status"] = "error"


def do_suspend():
    global _switching

    with _lock:
        variant = _state["variant"]
        _switching = True

    env = os.environ.copy()
    env["PATH"] = f"{ROOT_DIR}/.venv/bin:{env.get('PATH', '')}"
    subprocess.run(
        ["bash", f"{ROOT_DIR}/scripts/switch.sh", "--down"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=env,
        timeout=900,
    )

    with _lock:
        _switching = False
        _state["variant"] = ""
        _state["status"] = "unloaded"


def do_wake(variant):
    global _switching

    with _lock:
        _switching = True

    env = os.environ.copy()
    env["PATH"] = f"{ROOT_DIR}/.venv/bin:{env.get('PATH', '')}"
    ret = subprocess.run(
        ["bash", f"{ROOT_DIR}/scripts/switch.sh", variant, "--no-wait"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=env,
        timeout=900,
    )

    with _lock:
        _switching = False
        _state["variant"] = variant
        _state["status"] = "loading" if ret == 0 else "error"


def poll_loop():
    while True:
        try:
            variant, status = detect()
            with _lock:
                if not _switching:
                    _state["variant"] = variant
                    _state["status"] = status
        except Exception:
            pass
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
    if any(p in name for p in ("vllm", "beellama")):
        return "vllm/dual"
    if any(p in name for p in ("llama-cpp", "ik-llama")):
        return "llamacpp/mtp"
    return ""


def get_port(name):
    out = run(["docker", "port", name, "8000"])
    if not out:
        return None
    return out.strip().split(":")[-1]


def is_serving(port):
    try:
        subprocess.run(
            ["curl", "-sf", "--max-time", "2", f"http://localhost:{port}/v1/models"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
        return True
    except Exception:
        return False


def run(cmd):
    try:
        return subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True)
    except subprocess.CalledProcessError:
        return ""


if __name__ == "__main__":
    main()
