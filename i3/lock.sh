#!/bin/bash

# Derived from:
# /usr/share/doc/xss-lock/transfer-sleep-lock-i3lock.sh

unblurred=/tmp/i3-lock-screenshot.png
blurred=/tmp/i3-lock-screenshot-blurred.png
i3lock_options="--nofork -i $blurred --show-failed-attempts --ignore-empty-password"

maim $unblurred
convert -filter Point -scale 1.4% -resize 1920x1080\! -blur 0x2 $unblurred $blurred
rm $unblurred

# We set a trap to kill the locker if we get killed, then start the locker and
# wait for it to exit. The waiting is not that straightforward when the locker
# forks, so we use this polling only if we have a sleep lock to deal with.
if [[ -e /dev/fd/${XSS_SLEEP_LOCK_FD:--1} ]]; then
    kill_i3lock() {
        pkill -xu $EUID "$@" i3lock
    }

    trap kill_i3lock TERM INT

    # we have to make sure the locker does not inherit a copy of the lock fd
    i3lock $i3lock_options {XSS_SLEEP_LOCK_FD}<&-

    # now close our fd (only remaining copy) to indicate we're ready to sleep
    exec {XSS_SLEEP_LOCK_FD}<&-

    while kill_i3lock -0; do
        sleep 0.5
    done
else
    trap 'kill %%' TERM INT
    i3lock -n $i3lock_options &
    wait
fi
