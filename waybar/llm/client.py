"""LLM client — talks to the daemon via Unix socket.

Usage:
    python client.py button <variant> <label>   → JSON with text + class
    python client.py toggle <variant>           → toggles variant
    python client.py health                     → outputs nothing if daemon alive
    python client.py health-err                 → JSON error if daemon dead
"""
import json
import socket
import sys
import os

SOCK_PATH = os.path.expanduser("~/.cache/waybar-llm.sock")
TIMEOUT = 2  # seconds


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "health"

    if cmd == "health":
        pass  # placeholder, outputs nothing
    elif cmd == "health-err":
        if not query("status"):
            print(json.dumps({"text": "POLL DAEMON OFFLINE", "class": "offline"}))
    elif cmd == "button":
        variant, label = sys.argv[2], sys.argv[3]
        resp = query("status")
        if resp:
            active_variant, status = rsplit_once(resp)
            if active_variant == variant:
                # Active — show with its actual state class
                print(json.dumps({"text": label, "class": status}))
            else:
                # Not active — show as unloaded
                print(json.dumps({"text": label, "class": "unloaded"}))
        else:
            # Daemon unreachable
            print(json.dumps({"text": "", "class": "offline"}))
    elif cmd == "toggle":
        variant = sys.argv[2]
        query(f"toggle {variant}")


def query(msg):
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(TIMEOUT)
        s.connect(SOCK_PATH)
        s.sendall(msg.encode() + b"\n")
        resp = s.recv(4096).decode().strip()
        s.close()
        return resp
    except (OSError, socket.timeout, FileNotFoundError):
        return None


def rsplit_once(s):
    idx = s.rfind("/")
    return (s[:idx], s[idx + 1:]) if idx != -1 else ("", s)


if __name__ == "__main__":
    main()
