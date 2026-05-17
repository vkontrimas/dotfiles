#!/bin/bash

set -e

# Parse command line arguments
FORCE=false
while [[ $# -gt 0 ]]; do
    case $1 in
        --force|-f)
            FORCE=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--force|-f]"
            exit 1
            ;;
    esac
done

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

prompt_user() {
    local message="$1"
    local response

    while true; do
        echo -n -e "${YELLOW}$message (y/n): ${NC}"
        read response
        case "$response" in
            [Yy]* ) return 0;;
            [Nn]* ) return 1;;
            * ) echo "Please answer y or n.";;
        esac
    done
}

install_homebrew() {
    if command -v brew &> /dev/null; then
        echo -e "${GREEN}--- Homebrew already installed, skipping ---${NC}"
        return
    fi

    echo -e "${BLUE}--- Installing Homebrew ---${NC}"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
}

# Ensure Homebrew is on PATH for this session, regardless of whether it was
# just installed or already present (Linux doesn't add it to PATH by default).
load_homebrew_env() {
    if command -v brew &> /dev/null; then
        eval "$(brew shellenv)"
    elif [[ -x /home/linuxbrew/.linuxbrew/bin/brew ]]; then
        eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
    elif [[ -x "$HOME/.linuxbrew/bin/brew" ]]; then
        eval "$("$HOME/.linuxbrew/bin/brew" shellenv)"
    else
        echo -e "${RED}- Homebrew not found on PATH after install; aborting${NC}"
        exit 1
    fi
}

# Linuxbrew is not on PATH for login/GUI sessions by default. WezTerm (and
# anything else launched from the desktop) must be able to find the `nu`
# binary *before* nu's own config runs, so persist brew's shellenv into the
# login profile. Idempotent via a marker block.
persist_homebrew_env() {
    local profile="$HOME/.profile"
    local marker="# >>> dotfiles linuxbrew env >>>"
    local brew_bin
    brew_bin="$(command -v brew)"

    if [[ -f "$profile" ]] && grep -qF "$marker" "$profile"; then
        echo -e "${GREEN}--- Homebrew env already persisted in ~/.profile, skipping ---${NC}"
        return
    fi

    echo -e "${BLUE}--- Persisting Homebrew env to ~/.profile ---${NC}"
    {
        echo ""
        echo "$marker"
        echo "eval \"\$($brew_bin shellenv)\""
        echo "# <<< dotfiles linuxbrew env <<<"
    } >> "$profile"
    echo -e "${YELLOW}- Log out and back in (or run 'source ~/.profile') for GUI terminals to pick this up${NC}"
}

install_deps() {
    echo -e "${BLUE}--- Installing Dependencies ---${NC}"

    brew install \
        fnm \
        fd \
        eza \
        bat \
        fzf \
        ripgrep \
        tre-command \
        git-delta \
        graphviz \
        just \
        neovim \
        nushell
}

install_wezterm() {
    # Install WezTerm from its official apt repository rather than Homebrew:
    # the .deb ships a .desktop entry so it shows up in the application
    # launcher, which the Linuxbrew formula does not.
    if command -v wezterm &> /dev/null; then
        echo -e "${GREEN}--- WezTerm already installed, skipping ---${NC}"
        return
    fi

    echo -e "${BLUE}--- Installing WezTerm ---${NC}"

    if ! command -v gpg &> /dev/null; then
        echo -e "- Installing gpg via apt..."
        sudo apt-get update
        sudo apt-get install -y gnupg
    fi

    sudo mkdir -p /usr/share/keyrings
    curl -fsSL https://apt.fury.io/wez/gpg.key \
        | sudo gpg --yes --dearmor -o /usr/share/keyrings/wezterm-fury.gpg
    sudo chmod 644 /usr/share/keyrings/wezterm-fury.gpg
    echo 'deb [signed-by=/usr/share/keyrings/wezterm-fury.gpg] https://apt.fury.io/wez/ * *' \
        | sudo tee /etc/apt/sources.list.d/wezterm.list > /dev/null
    sudo apt-get update
    sudo apt-get install -y wezterm
    echo -e "${GREEN}- WezTerm installed!${NC}"
}

install_nerd_font() {
    # Homebrew on Linux has no cask support, so the Hurmit Nerd Font (a cask
    # font on macOS) has to be installed manually from the nerd-fonts release.
    local font_dir="$HOME/.local/share/fonts"
    if fc-list 2>/dev/null | grep -qi "Hurmit Nerd Font"; then
        echo -e "${GREEN}--- Hurmit Nerd Font already installed, skipping ---${NC}"
        return
    fi

    echo -e "${BLUE}--- Installing Hurmit Nerd Font ---${NC}"

    if ! command -v unzip &> /dev/null; then
        echo -e "- Installing unzip via apt..."
        sudo apt-get update
        sudo apt-get install -y unzip
    fi

    mkdir -p "$font_dir"
    local tmp
    tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/Hermit.zip" \
        https://github.com/ryanoasis/nerd-fonts/releases/latest/download/Hermit.zip
    unzip -o -q "$tmp/Hermit.zip" -d "$font_dir"
    rm -rf "$tmp"
    # Best-effort: the font files are already in place; a stale/unwritable
    # fontconfig cache is non-fatal (it rebuilds lazily) and must not abort
    # the script under `set -e`.
    fc-cache -f > /dev/null 2>&1 || echo -e "${YELLOW}- fc-cache reported an error; fonts are installed and the cache will rebuild on next use${NC}"
    echo -e "${GREEN}- Hurmit Nerd Font installed!${NC}"
}

link_dir() {
    local source="$1"
    local destination="$2"

    local full_source="$DOTFILES_DIR/$source"
    local dir_name=$(basename "$full_source")

    echo -e "${BLUE}--- Linking $dir_name ---${NC}"

    # Check if destination already exists
    if [[ -e "$destination" ]]; then
        # Check if it's already a symlink pointing to the right place
        if [[ -L "$destination" ]] && [[ "$(readlink "$destination")" == "$full_source" ]]; then
            echo -e "${GREEN}- Symlink already exists and points to correct target: $destination, skipping${NC}"
            return
        fi

        if [[ "$FORCE" != "true" ]]; then
            echo -e "${YELLOW}- Path already exists: $destination, skipping (use --force to overwrite)${NC}"
            return
        else
            echo -e "${YELLOW}- Removing existing path: $destination${NC}"
            rm -rf "$destination"
        fi
    fi

    local destination_dir=$(dirname "$destination")
    if [[ ! -d "$destination_dir" ]]; then
        echo -e "${BLUE}--- Creating directory: $destination_dir ---${NC}"
        mkdir -p "$destination_dir"
    fi

    echo -e "${BLUE}--- Creating symlink: $full_source -> $destination ---${NC}"
    ln -sf "$full_source" "$destination"
}

link_file() {
    local source="$1"
    local destination="$2"

    local full_source="$DOTFILES_DIR/$source"
    local file_name=$(basename "$full_source")

    echo -e "${BLUE}--- Linking $file_name ---${NC}"

    # Check if destination already exists
    if [[ -e "$destination" ]]; then
        # Check if it's already a symlink pointing to the right place
        if [[ -L "$destination" ]] && [[ "$(readlink "$destination")" == "$full_source" ]]; then
            echo -e "${GREEN}- Symlink already exists and points to correct target: $destination, skipping${NC}"
            return
        fi

        if [[ "$FORCE" != "true" ]]; then
            echo -e "${YELLOW}- File already exists: $destination, skipping (use --force to overwrite)${NC}"
            return
        else
            echo -e "${YELLOW}- Removing existing file: $destination${NC}"
            rm -f "$destination"
        fi
    fi

    local destination_dir=$(dirname "$destination")
    if [[ ! -d "$destination_dir" ]]; then
        echo -e "${BLUE}--- Creating directory: $destination_dir ---${NC}"
        mkdir -p "$destination_dir"
    fi

    echo -e "${BLUE}--- Creating symlink: $full_source -> $destination ---${NC}"
    ln -sf "$full_source" "$destination"
}

setup_git() {
    echo -e "${BLUE}--- Setting up Git configuration ---${NC}"

    # Add include directive to global gitconfig if not already present
    if ! git config --global --get-all include.path | grep -q "dotfiles/git/gitconfig"; then
        echo -e "- Adding dotfiles git config include..."
        git config --global include.path "$DOTFILES_DIR/git/gitconfig"
        echo -e "${GREEN}- Git configuration setup complete!${NC}"
    else
        echo -e "${GREEN}- Git configuration already setup, skipping${NC}"
    fi
}

setup_links() {
    echo -e "${BLUE}--- Linking dotfiles ---${NC}"

    # Standard XDG config directories (Linux)
    link_dir "nvim" "$HOME/.config/nvim"
    link_dir "nu" "$HOME/.config/nushell"

    # WezTerm configuration
    link_file "wezterm/wezterm.lua" "$HOME/.wezterm.lua"
}

setup_node() {
    echo -e "${BLUE}--- Setting up Node.js with fnm ---${NC}"

    # Initialize fnm environment
    echo -e "- Initializing fnm environment..."
    eval "$(fnm env --use-on-cd)"

    # Install latest LTS Node.js
    echo -e "- Installing latest LTS Node.js..."
    fnm install --lts
    fnm use lts-latest
    fnm default lts-latest

    echo -e "${GREEN}- Node.js setup complete!${NC}"
    node --version
    npm --version
}

setup_coding_agents() {
    echo -e "${BLUE}--- Installing Coding Agents ---${NC}"

    # Install Claude Code via the native installer (no cask support on Linux)
    if command -v claude &> /dev/null; then
        echo -e "${GREEN}- Claude Code already installed, skipping${NC}"
    else
        echo -e "- Installing Claude Code..."
        curl -fsSL https://claude.ai/install.sh | bash
        echo -e "${GREEN}- Claude Code installation complete!${NC}"
        claude --version
    fi

    # Install Pi Coding Agent
    if command -v pi &> /dev/null; then
        echo -e "${GREEN}- Pi already installed, skipping${NC}"
    else
        echo -e "- Installing Pi via npm..."
        npm install -g @earendil-works/pi-coding-agent
        echo -e "${GREEN}- Pi installation complete!${NC}"
        pi --version
    fi
}

upgrade_homebrew() {
    echo -e "${BLUE}--- Upgrading Homebrew and Packages ---${NC}"

    # Update homebrew itself
    echo -e "- Updating homebrew..."
    brew update

    # Upgrade all installed packages
    echo -e "- Upgrading installed packages..."
    brew upgrade

    echo -e "${GREEN}- Homebrew upgrade complete!${NC}"
}

show_post_install_notes() {
    echo -e "\n${GREEN}=== Setup Complete! ===${NC}"
    echo -e "\n${YELLOW}Post-installation notes:${NC}"
    echo -e "1. Log out and back in so GUI-launched terminals pick up Homebrew on"
    echo -e "   PATH (added to ~/.profile). Until then, WezTerm can't find 'nu'."
    echo -e "   For the current shell: source ~/.profile"
    echo -e "2. To set Nushell as your default shell, first register it, then chsh:"
    echo -e "     command -v nu | sudo tee -a /etc/shells"
    echo -e "     chsh -s \"\$(command -v nu)\""
    echo -e "   (chsh rejects shells not listed in /etc/shells)"
    echo -e "3. WezTerm and Nushell configs are linked and ready to use"
}

# Main execution
main() {
    echo -e "${GREEN}=== Linux Dotfiles Setup ===${NC}"

    install_homebrew
    load_homebrew_env
    persist_homebrew_env
    install_deps
    install_wezterm
    install_nerd_font
    upgrade_homebrew
    setup_node
    setup_coding_agents
    setup_git
    setup_links
    show_post_install_notes
}

# Check if script is being sourced or executed
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
