#!/bin/sh

i3-msg "append_layout $HOME/.i3/layouts/webdev2.json"
firefox & disown
google-chrome & disown
for i in $(seq 0 6)
do
  alacritty --working-directory ~/code & disown
done
