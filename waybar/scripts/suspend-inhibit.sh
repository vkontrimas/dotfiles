#!/bin/bash
# Waybar suspend-inhibit toggle.
#   button → JSON with text + class for current inhibit state
#   toggle → start or stop systemd suspend inhibition
PID_FILE="$HOME/.cache/waybar-suspend-inhibit.pid"

is_inhibited() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

case "$1" in
  button)
    if is_inhibited; then
      echo '{"text": "INHB", "class": "inhibited"}'
    else
      echo '{"text": "INHB", "class": "uninhibited"}'
    fi
    ;;
  toggle)
    if is_inhibited; then
      local_pid=$(cat "$PID_FILE")
      kill "$local_pid" 2>/dev/null
      rm -f "$PID_FILE"
    else
      mkdir -p "$(dirname "$PID_FILE")"
      systemd-inhibit --why="waybar suspend inhibit" --what=sleep sleep infinity &
      echo $! > "$PID_FILE"
    fi
    ;;
esac
