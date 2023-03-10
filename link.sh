#!/bin/zsh

# i3
ln -s "$(realpath i3)" -t ~/.config

# zprezto
setopt EXTENDED_GLOB
for rcfile in zprezto/runcoms/^README.md(.N); do
  ln -s "$(realpath $rcfile)" "${ZDOTDIR:-$HOME}/.${rcfile:t}"
done

# nvim
ln -s "$(realpath nvim)" -t ~/.config
