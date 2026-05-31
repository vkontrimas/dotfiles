#!/bin/bash
set -euo pipefail

LUKS_UUID="b324a88c-e07f-4b28-a933-ffbf1289653e"
LUKS_DEVICE="/dev/sda1"
MAPPER_NAME="data-ssd"
KEYFILE="/etc/luks-keys/sda1.key"
MOUNT_POINT="/home/kinetic/data"
OWNER="kinetic"

ok()   { echo "[OK]   $*"; }
skip() { echo "[SKIP] $*"; }
run()  { echo "[RUN]  $*"; }

# 1. Create keyfile
if [[ ! -f "$KEYFILE" ]]; then
    run "Creating keyfile at $KEYFILE"
    mkdir -p "$(dirname "$KEYFILE")"
    dd if=/dev/urandom of="$KEYFILE" bs=4096 count=1 status=none
    chmod 600 "$KEYFILE"
    ok "Keyfile created"
else
    skip "Keyfile already exists"
fi

# 2. Register keyfile with LUKS (prompts for existing passphrase if needed)
if cryptsetup open --test-passphrase --key-file "$KEYFILE" "$LUKS_DEVICE" &>/dev/null; then
    skip "Keyfile already registered with LUKS"
else
    run "Adding keyfile to LUKS — enter your existing LUKS passphrase:"
    cryptsetup luksAddKey "$LUKS_DEVICE" "$KEYFILE"
    ok "Keyfile registered with LUKS"
fi

# 3. crypttab entry
if grep -qF "$MAPPER_NAME" /etc/crypttab 2>/dev/null; then
    skip "crypttab entry already present"
else
    run "Adding entry to /etc/crypttab"
    echo "$MAPPER_NAME UUID=$LUKS_UUID $KEYFILE luks" >> /etc/crypttab
    ok "crypttab updated"
fi

# 4. fstab entry
if grep -qF "/dev/mapper/$MAPPER_NAME" /etc/fstab 2>/dev/null; then
    skip "fstab entry already present"
else
    run "Adding entry to /etc/fstab"
    echo "/dev/mapper/$MAPPER_NAME $MOUNT_POINT ext4 defaults,nofail,x-systemd.device-timeout=10 0 2" >> /etc/fstab
    ok "fstab updated"
fi

# 5. Reload systemd unit files
run "Reloading systemd"
systemctl daemon-reload
ok "systemd reloaded"

# 6. Open LUKS device
if [[ -e "/dev/mapper/$MAPPER_NAME" ]]; then
    skip "LUKS device already open at /dev/mapper/$MAPPER_NAME"
else
    run "Opening LUKS container"
    cryptsetup open "$LUKS_DEVICE" "$MAPPER_NAME" --key-file "$KEYFILE"
    ok "LUKS container opened"
fi

# 7. Mount
if mountpoint -q "$MOUNT_POINT"; then
    skip "$MOUNT_POINT already mounted"
else
    run "Mounting $MOUNT_POINT"
    mount "$MOUNT_POINT"
    ok "Mounted"
fi

# 8. Ownership (idempotent)
chown "$OWNER:$OWNER" "$MOUNT_POINT"
ok "Ownership set to $OWNER"

echo ""
echo "All done. Verify:"
echo "  df -h $MOUNT_POINT"
echo "  ls -ld $MOUNT_POINT"
