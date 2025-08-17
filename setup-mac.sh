#!/bin/bash

set -e

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
    
    # Add Homebrew to PATH for this session
    if [[ $(uname -m) == "arm64" ]]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    else
        eval "$(/usr/local/bin/brew shellenv)"
    fi
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
        neovim \
        nushell \
        font-hurmit-nerd-font
}

install_iterm2() {
    if [[ -d "/Applications/iTerm.app" ]]; then
        echo -e "${GREEN}--- iTerm2 already installed, skipping ---${NC}"
        return
    fi
    
    echo -e "${BLUE}--- Installing iTerm2 ---${NC}"
    brew install --cask iterm2
}

link_dir() {
    local source="$1"
    local destination="$2"
    
    local full_source="$DOTFILES_DIR/$source"
    local dir_name=$(basename "$full_source")
    
    echo -e "${BLUE}--- Linking $dir_name ---${NC}"
    
    if [[ -L "$destination" ]]; then
        echo -e "${GREEN}- Symlink already exists: $destination, skipping${NC}"
        return
    fi
    
    if [[ -e "$destination" ]]; then
        if prompt_user "Directory/file exists at $destination. Remove it?"; then
            rm -rf "$destination"
        else
            echo -e "${YELLOW}- Skipping $destination${NC}"
            return
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
        git config --global include.path ~/dotfiles/git/gitconfig
        echo -e "${GREEN}- Git configuration setup complete!${NC}"
    else
        echo -e "${GREEN}- Git configuration already setup, skipping${NC}"
    fi
}

setup_links() {
    echo -e "${BLUE}--- Linking dotfiles ---${NC}"
    
    # Standard config directories
    link_dir "alacritty" "$HOME/.config/alacritty"
    link_dir "nvim" "$HOME/.config/nvim"
    link_dir "nu" "$HOME/Library/Application Support/nushell"
    
    # iTerm2 profile configuration
    link_dir "iterm2/nushell-dark.json" "$HOME/Library/Application Support/iTerm2/DynamicProfiles/nushell-dark.json"
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

setup_claude_code() {
    echo -e "${BLUE}--- Installing Claude Code ---${NC}"
    
    # Check if Claude Code is already installed
    if command -v claude &> /dev/null; then
        echo -e "${GREEN}- Claude Code already installed, skipping${NC}"
        return
    fi
    
    # Install Claude Code via npm
    echo -e "- Installing Claude Code via npm..."
    npm install -g @anthropic/claude-code
    
    echo -e "${GREEN}- Claude Code installation complete!${NC}"
    claude --version
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
    echo -e "${YELLOW}1. Restart iTerm2 and select the 'Nushell Dark' profile${NC}"
    echo -e "${YELLOW}2. Alacritty config is linked in case you want to use it on macOS${NC}"
}

# Main execution
main() {
    echo -e "${GREEN}=== macOS Dotfiles Setup ===${NC}"
    
    install_homebrew
    install_deps
    install_iterm2
    upgrade_homebrew
    setup_node
    setup_claude_code
    setup_git
    setup_links
    show_post_install_notes
}

# Check if script is being sourced or executed
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi