#!/bin/bash
# Waybar power-profile toggle.
#   button → JSON with text + class for the current profile
#   toggle → flip between performance and balanced
case "$1" in
  button)
    if [[ "$(powerprofilesctl get 2>/dev/null)" == "performance" ]]; then
      echo '{"text": "PERF", "class": "perf"}'
    else
      echo '{"text": "BLNC", "class": "blnc"}'
    fi
    ;;
  toggle)
    if [[ "$(powerprofilesctl get 2>/dev/null)" == "performance" ]]; then
      powerprofilesctl set balanced
    else
      powerprofilesctl set performance
    fi
    ;;
esac
