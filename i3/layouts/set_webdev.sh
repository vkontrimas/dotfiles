#!/bin/sh

i3-msg "workspace 4; append_layout $HOME/.i3/layouts/webdev.json"
firefox & disown
for i in $(seq 0 3)
do
  alacritty & disown
done
