#!/usr/bin/env bash
# Recreate the standard desktop layout at login. Each app is launched, then moved
# explicitly to its target workspace by app_id so placement is deterministic even
# if an app (e.g. Firefox) is already running. Workspaces are pinned to outputs in
# the sway config. Launched once via `exec` from the sway config.
#
# Final layout:
#   DP-1 (left, portrait)  ws2: one terminal in a stacking container
#   DP-2 (main)            ws1: Firefox (restores its own last session)
#   DP-2 (main)            ws3: two terminals, splith, narrow-left / wide-right
#   scratchpad             one floating terminal sized 1300x1302

set -u

msg() { swaymsg "$@" >/dev/null; }

# wait_win <app_id> — block until a window with this app_id exists (timeout ~10s).
wait_win() {
  for _ in $(seq 1 100); do
    swaymsg -t get_tree | jq -e --arg id "$1" \
      'recurse(.nodes[]?, .floating_nodes[]?) | select(.app_id == $id)' >/dev/null 2>&1 && return 0
    sleep 0.1
  done
}

# ws2 (DP-1): one terminal in a stacking container.
msg "workspace number 2"
alacritty --class boot_left &
wait_win boot_left
msg "[app_id=boot_left] move container to workspace number 2"
msg "[app_id=boot_left] layout stacking"

# ws3 (DP-2): two terminals side by side; left first (narrow), right second (wide).
msg "workspace number 3"
alacritty --class boot_main_l &
wait_win boot_main_l
msg "[app_id=boot_main_l] move container to workspace number 3"
alacritty --class boot_main_r &
wait_win boot_main_r
msg "[app_id=boot_main_r] move container to workspace number 3"
# Left pane ~32% wide (996/3072 from the captured layout).
msg "[app_id=boot_main_l] resize set width 32 ppt"

# ws1 (DP-2): browser. Move by app_id so it lands here even if Firefox was already running.
msg "workspace number 1"
firefox &
wait_win firefox
msg "[app_id=firefox] move container to workspace number 1"

# Scratch terminal: floats + resizes via the for_window rule in the config, then hides.
alacritty --class scratch_term &
wait_win scratch_term
msg "[app_id=scratch_term] move scratchpad"

# End with the terminal workspace shown and focused on the main monitor (DP-1 stays on ws2).
msg "workspace number 3"
