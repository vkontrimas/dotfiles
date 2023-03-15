# Deps
- maim
- xclip
- feh
- rofi

```
sudo apt install maim xclip feh rofi
```

# Bits and bobs
## Wallpaper
[sourced from here](https://wall.alphacoders.com/big.php?i=110966)

## Configuring trackpad
```
xinput
```

To list input devices and get trackpad id.

```
xinput list-props <touchpad id>
```

To get properties.

```
xinput set-prop <touchpad id> <property id> <value>
```
To set properties.

Unfortunately I was not able to find a way to enable double-click when clicking with two fingers. However, enabling tapping also enabled two finger TAP but not CLICK. It will have to do.
