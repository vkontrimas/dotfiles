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

# alacritty
ln -s "$(realpath alacritty)" -t "$HOME/.config"

# fontconfig
ln -s "$(realpath fontconfig)" -t "$HOME/.config"

# set up git aliases
git config --global alias.st status
git config --global alias.amend "commit --amend"
git config --global alias.ll 'log'
git config --global alias.l '!git --no-pager log --oneline -20'
