#!/bin/bash

launch() {
  # echo $@
  coproc ( "$@"  > /dev/null  2>&1 )
}

case "$@" in
  'shutdown')
    launch shutdown now
    ;;
  'restart')
    launch shutdown now -r
    ;;
  'sleep (suspend)')
    launch systemctl suspend
    ;;
  'lock')
    launch $HOME/.i3/lock.sh
    ;;
  'exit')
    launch i3-msg exit
    ;;
  *)
    echo 'lock'
    echo 'exit'
    echo 'sleep (suspend)'
    echo 'shutdown'
    echo 'restart'
    ;;
esac

