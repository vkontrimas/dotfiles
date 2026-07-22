local wezterm = require("wezterm")
local config = wezterm.config_builder()

-- Font configuration
config.font = wezterm.font("Hurmit Nerd Font Mono")
config.font_size = 11.0

-- Shell configuration
config.default_prog = { "nu" }

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

-- Leader key (tmux-style prefix): Ctrl+Space
config.leader = { key = "Space", mods = "CTRL", timeout_milliseconds = 1000 }

-- Keybindings
config.keys = {
  -- Splits: leader d = left/right, leader shift+d = top/bottom
  {
    key = "d",
    mods = "LEADER",
    action = wezterm.action.SplitHorizontal({ domain = "CurrentPaneDomain" }),
  },
  {
    key = "D",
    mods = "LEADER|SHIFT",
    action = wezterm.action.SplitVertical({ domain = "CurrentPaneDomain" }),
  },

  -- Pane navigation via leader (vim keys)
  {
    key = "h",
    mods = "LEADER",
    action = wezterm.action.ActivatePaneDirection("Left"),
  },
  {
    key = "j",
    mods = "LEADER",
    action = wezterm.action.ActivatePaneDirection("Down"),
  },
  {
    key = "k",
    mods = "LEADER",
    action = wezterm.action.ActivatePaneDirection("Up"),
  },
  {
    key = "l",
    mods = "LEADER",
    action = wezterm.action.ActivatePaneDirection("Right"),
  },

  -- Fast pane navigation (no leader): Alt + vim keys
  {
    key = "h",
    mods = "ALT",
    action = wezterm.action.ActivatePaneDirection("Left"),
  },
  {
    key = "j",
    mods = "ALT",
    action = wezterm.action.ActivatePaneDirection("Down"),
  },
  {
    key = "k",
    mods = "ALT",
    action = wezterm.action.ActivatePaneDirection("Up"),
  },
  {
    key = "l",
    mods = "ALT",
    action = wezterm.action.ActivatePaneDirection("Right"),
  },

  -- Resize panes (leader + shift + vim keys)
  {
    key = "H",
    mods = "LEADER|SHIFT",
    action = wezterm.action.AdjustPaneSize({ "Left", 5 }),
  },
  {
    key = "J",
    mods = "LEADER|SHIFT",
    action = wezterm.action.AdjustPaneSize({ "Down", 5 }),
  },
  {
    key = "K",
    mods = "LEADER|SHIFT",
    action = wezterm.action.AdjustPaneSize({ "Up", 5 }),
  },
  {
    key = "L",
    mods = "LEADER|SHIFT",
    action = wezterm.action.AdjustPaneSize({ "Right", 5 }),
  },

  -- Pane management
  {
    key = "x",
    mods = "LEADER",
    action = wezterm.action.CloseCurrentPane({ confirm = false }),
  },
  {
    key = "z",
    mods = "LEADER",
    action = wezterm.action.TogglePaneZoomState,
  },

  -- Tabs
  {
    key = "t",
    mods = "LEADER",
    action = wezterm.action.SpawnTab("CurrentPaneDomain"),
  },
  {
    key = "n",
    mods = "LEADER",
    action = wezterm.action.ActivateTabRelative(1),
  },
  {
    key = "p",
    mods = "LEADER",
    action = wezterm.action.ActivateTabRelative(-1),
  },
  {
    key = "w",
    mods = "LEADER",
    action = wezterm.action.CloseCurrentTab({ confirm = false }),
  },

  -- Claude Code shift enter hack
  {
    key = "Enter",
    mods = "SHIFT",
    action = wezterm.action({ SendString = "\x1b\r" }),
  },
}

-- Jump to tab N: leader + 1..9
for i = 1, 9 do
  table.insert(config.keys, {
    key = tostring(i),
    mods = "LEADER",
    action = wezterm.action.ActivateTab(i - 1),
  })
end

-- Ayu Dark color scheme
config.colors = {
  -- Primary colors
  foreground = "#B3B1AD",
  background = "#0A0E14",

  -- Cursor colors
  cursor_bg = "#B3B1AD",
  cursor_fg = "#0A0E14",
  cursor_border = "#B3B1AD",

  -- Selection colors
  selection_fg = "#0A0E14",
  selection_bg = "#B3B1AD",

  -- ANSI colors
  ansi = {
    "#01060E", -- black
    "#EA6C73", -- red
    "#91B362", -- green
    "#F9AF4F", -- yellow
    "#53BDFA", -- blue
    "#FAE994", -- magenta
    "#90E1C6", -- cyan
    "#C7C7C7", -- white
  },

  -- Bright ANSI colors
  brights = {
    "#686868", -- bright black
    "#F07178", -- bright red
    "#C2D94C", -- bright green
    "#FFB454", -- bright yellow
    "#59C2FF", -- bright blue
    "#FFEE99", -- bright magenta
    "#95E6CB", -- bright cyan
    "#FFFFFF", -- bright white
  },
}

return config
