#!/bin/zsh

ln -sf "$(realpath i3/config)" "$HOME/.config/i3/config"

setopt EXTENDED_GLOB
for rcfile in zprezto/runcoms/^README.md(.N); do
  ln -s "$(realpath $rcfile)" "${ZDOTDIR:-$HOME}/.${rcfile:t}"
done
