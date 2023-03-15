#!/bin/zsh

# i3
i3_dir="$HOME/.i3"
if [ ! -d $i3_dir ]
then
  ln -s "$(realpath i3)" $i3_dir
else
  echo $i3_dir already exists!
fi

# zprezto
setopt EXTENDED_GLOB
for rcfile in zprezto/runcoms/^README.md(.N); do
  ln -s "$(realpath $rcfile)" "${ZDOTDIR:-$HOME}/.${rcfile:t}"
done

# nvim
ln -s "$(realpath nvim)" -t "$HOME/.config"

# Xresources
ln -s "$(realpath x11/Xresources)" "$HOME/.Xresources"

# GTK
ln -s "$(realpath gtk/settings.ini)" "$HOME/.config/gtk-3.0/settings.ini"
