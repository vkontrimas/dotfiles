#!/bin/bash
set -euo pipefail

POWER_LIMIT_W="300"
SERVICE_NAME="nvidia-powerlimit"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
SLEEP_HOOK="/usr/lib/systemd/system-sleep/nvidia-powerlimit"
NVIDIA_SMI="$(command -v nvidia-smi || echo /usr/bin/nvidia-smi)"

ok()   { echo "[OK]   $*"; }
skip() { echo "[SKIP] $*"; }
run()  { echo "[RUN]  $*"; }
err()  { echo "[ERR]  $*" >&2; }

# 0. Sanity checks
if [[ $EUID -ne 0 ]]; then
    err "This script must be run as root (use sudo)."
    exit 1
fi

if [[ ! -x "$NVIDIA_SMI" ]]; then
    err "nvidia-smi not found. Is the NVIDIA driver installed?"
    exit 1
fi

# Validate the requested power limit is within the GPU's supported range.
read -r MIN_LIMIT MAX_LIMIT < <(
    "$NVIDIA_SMI" --query-gpu=power.min_limit,power.max_limit \
        --format=csv,noheader,nounits -i 0 | tr -d ' ' | tr ',' ' '
)
if [[ -n "${MIN_LIMIT:-}" && -n "${MAX_LIMIT:-}" ]]; then
    # Compare as integers (round the float bounds).
    min_int=${MIN_LIMIT%.*}
    max_int=${MAX_LIMIT%.*}
    if (( POWER_LIMIT_W < min_int || POWER_LIMIT_W > max_int )); then
        err "Requested ${POWER_LIMIT_W}W is outside supported range ${min_int}-${max_int}W."
        exit 1
    fi
    ok "Requested ${POWER_LIMIT_W}W is within supported range ${min_int}-${max_int}W"
fi

# 1. Write the systemd unit (overwrites any previous version idempotently).
DESIRED_UNIT="[Unit]
Description=Set NVIDIA GPU power limit to ${POWER_LIMIT_W}W
After=multi-user.target
Wants=multi-user.target

[Service]
Type=oneshot
# Persistence mode keeps the driver loaded so the limit sticks.
ExecStartPre=${NVIDIA_SMI} -pm 1
ExecStart=${NVIDIA_SMI} -pl ${POWER_LIMIT_W}
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target"

if [[ -f "$SERVICE_FILE" ]] && [[ "$(cat "$SERVICE_FILE")" == "$DESIRED_UNIT" ]]; then
    skip "Unit file already up to date at $SERVICE_FILE"
else
    run "Writing unit file to $SERVICE_FILE"
    printf '%s\n' "$DESIRED_UNIT" > "$SERVICE_FILE"
    ok "Unit file written"
fi

# 2. Write the resume hook so the limit is re-applied after suspend/resume.
#    systemd calls system-sleep scripts with "pre"/"post" + the sleep type;
#    we only act on "post" (i.e. after waking back up).
DESIRED_HOOK="#!/bin/bash
# Re-apply NVIDIA power limit after resuming from sleep/hibernate.
case \"\$1\" in
    post)
        ${NVIDIA_SMI} -pm 1
        ${NVIDIA_SMI} -pl ${POWER_LIMIT_W}
        ;;
esac"

if [[ -f "$SLEEP_HOOK" ]] && [[ "$(cat "$SLEEP_HOOK")" == "$DESIRED_HOOK" ]]; then
    skip "Sleep hook already up to date at $SLEEP_HOOK"
else
    run "Writing sleep hook to $SLEEP_HOOK"
    mkdir -p "$(dirname "$SLEEP_HOOK")"
    printf '%s\n' "$DESIRED_HOOK" > "$SLEEP_HOOK"
    chmod +x "$SLEEP_HOOK"
    ok "Sleep hook written"
fi

# 3. Reload systemd so it picks up any changes.
run "Reloading systemd"
systemctl daemon-reload
ok "systemd reloaded"

# 4. Enable on boot (idempotent).
if systemctl is-enabled --quiet "$SERVICE_NAME"; then
    skip "$SERVICE_NAME already enabled"
else
    run "Enabling $SERVICE_NAME"
    systemctl enable "$SERVICE_NAME"
    ok "$SERVICE_NAME enabled"
fi

# 5. Apply now (restart so it re-runs even if a previous attempt failed).
run "Applying power limit now"
systemctl restart "$SERVICE_NAME"
ok "Power limit applied"

echo ""
echo "All done. Verify:"
echo "  systemctl status $SERVICE_NAME"
echo "  nvidia-smi --query-gpu=power.limit --format=csv"
