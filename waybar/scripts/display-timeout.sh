#!/bin/bash
# Waybar display-timeout toggle.
#   button → JSON with text + class for current inhibit state
#   toggle → create or remove the display-inhibit marker file
INHIBIT_FILE="$HOME/.cache/waybar-display-inhibit"

is_inhibited() {
  [[ -f "$INHIBIT_FILE" ]]
}

case "$1" in
  button)
    if is_inhibited; then
      echo '{"text": "PWRD", "class": "inhibited"}'
    else
      echo '{"text": "TIMR", "class": "uninhibited"}'
    fi
    ;;
  toggle)
    if is_inhibited; then
      rm -f "$INHIBIT_FILE"
    else
      mkdir -p "$(dirname "$INHIBIT_FILE")"
      touch "$INHIBIT_FILE"
    fi
    ;;
esac
