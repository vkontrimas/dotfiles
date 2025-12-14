local wezterm = require 'wezterm'
local config = wezterm.config_builder()

-- Font configuration
config.font = wezterm.font 'Hurmit Nerd Font Mono'
config.font_size = 11.0

-- Shell configuration
config.default_prog = { 'nu' }

-- Window configuration
config.initial_cols = 120
config.initial_rows = 40
config.window_decorations = "INTEGRATED_BUTTONS|RESIZE"

-- Start maximized
wezterm.on('gui-startup', function(cmd)
  local tab, pane, window = wezterm.mux.spawn_window(cmd or {})
  window:gui_window():maximize()
end)

-- Padding configuration
config.window_padding = {
  left = 15,
  right = 15,
  top = 15,
  bottom = 15,
}

-- Enable live config reload
config.automatically_reload_config = true

-- Disable terminal bell
config.audible_bell = "Disabled"

-- Keybindings
config.keys = {
  -- Split vertically (left-right)
  {
    key = 'd',
    mods = 'CTRL|ALT',
    action = wezterm.action.SplitHorizontal { domain = 'CurrentPaneDomain' },
  },
  -- Split horizontally (top-bottom)
  {
    key = 'd',
    mods = 'CTRL|SHIFT|ALT',
    action = wezterm.action.SplitVertical { domain = 'CurrentPaneDomain' },
  },
  -- Navigate panes
  {
    key = 'LeftArrow',
    mods = 'CTRL|ALT',
    action = wezterm.action.ActivatePaneDirection 'Left',
  },
  {
    key = 'RightArrow',
    mods = 'CTRL|ALT',
    action = wezterm.action.ActivatePaneDirection 'Right',
  },
  {
    key = 'UpArrow',
    mods = 'CTRL|ALT',
    action = wezterm.action.ActivatePaneDirection 'Up',
  },
  {
    key = 'DownArrow',
    mods = 'CTRL|ALT',
    action = wezterm.action.ActivatePaneDirection 'Down',
  },
  -- Resize panes
  {
    key = 'LeftArrow',
    mods = 'CTRL|SHIFT|ALT',
    action = wezterm.action.AdjustPaneSize { 'Left', 5 },
  },
  {
    key = 'RightArrow',
    mods = 'CTRL|SHIFT|ALT',
    action = wezterm.action.AdjustPaneSize { 'Right', 5 },
  },
  {
    key = 'UpArrow',
    mods = 'CTRL|SHIFT|ALT',
    action = wezterm.action.AdjustPaneSize { 'Up', 5 },
  },
  {
    key = 'DownArrow',
    mods = 'CTRL|SHIFT|ALT',
    action = wezterm.action.AdjustPaneSize { 'Down', 5 },
  },
}

-- Ayu Dark color scheme
config.colors = {
  -- Primary colors
  foreground = '#B3B1AD',
  background = '#0A0E14',

  -- Cursor colors
  cursor_bg = '#B3B1AD',
  cursor_fg = '#0A0E14',
  cursor_border = '#B3B1AD',

  -- Selection colors
  selection_fg = '#0A0E14',
  selection_bg = '#B3B1AD',

  -- ANSI colors
  ansi = {
    '#01060E', -- black
    '#EA6C73', -- red
    '#91B362', -- green
    '#F9AF4F', -- yellow
    '#53BDFA', -- blue
    '#FAE994', -- magenta
    '#90E1C6', -- cyan
    '#C7C7C7', -- white
  },

  -- Bright ANSI colors
  brights = {
    '#686868', -- bright black
    '#F07178', -- bright red
    '#C2D94C', -- bright green
    '#FFB454', -- bright yellow
    '#59C2FF', -- bright blue
    '#FFEE99', -- bright magenta
    '#95E6CB', -- bright cyan
    '#FFFFFF', -- bright white
  },
}

return config
