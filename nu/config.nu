# config.nu
#
# Installed by:
# version = "0.105.1"
#
# This file is used to override default Nushell settings, define
# (or import) custom commands, or run any other startup tasks.
# See https://www.nushell.sh/book/configuration.html
#
# This file is loaded after env.nu and before login.nu
#
# You can open this file in your default editor using:
# config nu
#
# See `help config nu` for more options
#
# You can remove these comments if you want or leave
# them for future reference.

use std/dirs

# Setup Homebrew (macOS only)
if $nu.os-info.name == 'macos' {
    let brew_path = if ($nu.os-info.arch == 'aarch64') { '/opt/homebrew/bin/brew' } else { '/usr/local/bin/brew' }
    if ($brew_path | path exists) {
        ^$brew_path shellenv | lines | each { |line| 
            let parts = ($line | parse --regex 'export (?P<name>\w+)="?(?P<value>[^"]*)"?')
            if not ($parts | is-empty) {
                let var = $parts | get 0
                load-env {($var.name): ($var.value)}
            }
        }
        
        # Add Homebrew bin paths to PATH
        let homebrew_prefix = if ($nu.os-info.arch == 'aarch64') { '/opt/homebrew' } else { '/usr/local' }
        $env.PATH = $env.PATH | prepend [$"($homebrew_prefix)/bin", $"($homebrew_prefix)/sbin"]
    }
}

# Add Rust/Cargo bin directory to PATH
let home_dir = if $nu.os-info.name == 'windows' { $env.USERPROFILE } else { $env.HOME }
let cargo_bin = $"($home_dir)/.cargo/bin"
if ($cargo_bin | path exists) {
    $env.PATH = $env.PATH | prepend $cargo_bin
}

if not (which fnm | is-empty) {
    ^fnm env --json | from json | load-env

    $env.PATH = $env.PATH | prepend ($env.FNM_MULTISHELL_PATH | path join (if $nu.os-info.name == 'windows' {''} else {'bin'}))
    $env.config.hooks.env_change.PWD = (
        $env.config.hooks.env_change.PWD? | append {
            condition: {|| ['.nvmrc' '.node-version', 'package.json'] | any {|el| $el | path exists}}
            code: {|| ^fnm use}
        }
    )
}

alias tree = tre

alias fcd = cd (fd -t d | fzf)

def __dirs_index_fzf [] {
    # Returns index selected via fzf
    let selected_path = dirs | get path | str join "\n" | fzf
    let selected_index = dirs | enumerate | flatten | where path == $selected_path | get index | first
    $selected_index
}
alias fdir = dirs goto (__dirs_index_fzf)
