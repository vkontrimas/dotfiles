#!/bin/zsh

# i3
I3_WALLPAPER_DIR="$HOME/Pictures"
mkdir -p "$I3_WALLPAPER_DIR"
ln -s "$(realpath i3/wallpaper.jpg)" "$I3_WALLPAPER_DIR/.i3_wallpaper.jpg"

ln -s "$(realpath i3/lock.sh)" "$HOME/.lock.sh"

I3_CONFIG_DIR="$HOME/.config/i3"
mkdir -p "$I3_CONFIG_DIR"

echo "include $(realpath i3/config)\n#include $(realpath i3/laptop)" > "$I3_CONFIG_DIR/config"

# zprezto
setopt EXTENDED_GLOB
for rcfile in zprezto/runcoms/^README.md(.N); do
  ln -s "$(realpath $rcfile)" "${ZDOTDIR:-$HOME}/.${rcfile:t}"
done

# nvim
ln -s "$(realpath nvim)" -t ~/.config
