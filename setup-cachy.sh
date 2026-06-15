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

# Check if a pacman package is installed
pacman_installed() {
    pacman -Q "$1" &> /dev/null
}

# Install packages via pacman, skipping those already installed.
# Returns 0 if at least one package was installed, 1 if all were already present.
install_pacman_packages() {
    local packages=("$@")
    local to_install=()

    for pkg in "${packages[@]}"; do
        if pacman_installed "$pkg"; then
            echo -e "${GREEN}- $pkg already installed, skipping${NC}"
        else
            to_install+=("$pkg")
        fi
    done

    if [[ ${#to_install[@]} -eq 0 ]]; then
        echo -e "${GREEN}--- All packages already installed, skipping pacman install ---${NC}"
        return 1
    fi

    echo -e "${BLUE}--- Installing packages via pacman: ${to_install[*]} ---${NC}"
    sudo pacman -S --needed --noconfirm "${to_install[@]}"
    return 0
}

install_deps() {
    echo -e "${BLUE}--- Installing Dependencies ---${NC}"

    # Core CLI tools
    install_pacman_packages \
        fnm \
        fd \
        eza \
        bat \
        fzf \
        ripgrep \
        tre \
        git-delta \
        graphviz \
        just \
        neovim \
        nushell \
        tree-sitter-cli \
        sway \
        swaylock \
        swayidle \
        grim \
        satty \
        wmenu \
        jq \
        wireplumber \
        playerctl \
        brightnessctl \
        waybar \
        uv \
        docker \
        docker-compose \
        lf \
        alacritty || true

    # Nerd Font (Hurmit)
    if pacman_installed otf-hermit-nerd; then
        echo -e "${GREEN}- otf-hermit-nerd already installed, skipping${NC}"
    else
        echo -e "${BLUE}--- Installing Hurmit Nerd Font ---${NC}"
        sudo pacman -S --needed --noconfirm otf-hermit-nerd
        fc-cache -f > /dev/null 2>&1 || echo -e "${YELLOW}- fc-cache reported an error; fonts are installed and the cache will rebuild on next use${NC}"
        echo -e "${GREEN}- Hurmit Nerd Font installed!${NC}"
    fi

    # WezTerm (may not be in official repos on all Arch variants)
    if command -v wezterm &> /dev/null; then
        echo -e "${GREEN}--- WezTerm already installed, skipping ---${NC}"
    elif pacman_installed wezterm; then
        echo -e "${GREEN}--- WezTerm already installed (pacman), skipping ---${NC}"
    else
        echo -e "${YELLOW}--- WezTerm not available via pacman, skipping (install via AUR if needed) ---${NC}"
    fi
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
    link_dir "sway" "$HOME/.config/sway"
    link_dir "swaylock" "$HOME/.config/swaylock"
    link_dir "swayidle" "$HOME/.config/swayidle"
    link_dir "waybar" "$HOME/.config/waybar"
    link_dir "alacritty" "$HOME/.config/alacritty"
    link_dir "lf" "$HOME/.config/lf"
    link_dir "satty" "$HOME/.config/satty"
    link_dir "gtk-3.0" "$HOME/.config/gtk-3.0"
    link_dir "gtk-4.0" "$HOME/.config/gtk-4.0"

    # Set portal color-scheme so Firefox/Electron/libadwaita apps detect dark mode
    if [[ "$(gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null)" != "'prefer-dark'" ]]; then
        gsettings set org.gnome.desktop.interface color-scheme 'prefer-dark'
        echo -e "${GREEN}- Set color-scheme to prefer-dark${NC}"
    else
        echo -e "${GREEN}- color-scheme already prefer-dark, skipping${NC}"
    fi

    # SSH config (agent.conf and config only — private keys stay in ~/.ssh/)
    link_file "profile/profile" "$HOME/.profile"
    link_file "ssh/agent.conf" "$HOME/.ssh/agent.conf"
    link_file "ssh/config" "$HOME/.ssh/config"

    # Sway NVIDIA wrapper — must be executable
    local sway_wrapper="$HOME/.config/sway/sway-launch.sh"
    if [[ -f "$sway_wrapper" ]]; then
        chmod +x "$sway_wrapper"
    fi

    # Ly custom session (overrides /usr/share/wayland-sessions/sway.desktop)
    local ly_custom="/etc/ly/custom-sessions"
    if [[ -d "$ly_custom" ]]; then
        local full_desktop="$DOTFILES_DIR/sway/sway-nvidia.desktop"
        if [[ -f "$ly_custom/sway-nvidia.desktop" ]] && diff -q "$full_desktop" "$ly_custom/sway-nvidia.desktop" &>/dev/null; then
            echo -e "${GREEN}- Ly custom sway-nvidia.desktop already in place, skipping${NC}"
        else
            echo -e "${BLUE}--- Installing Ly custom sway-nvidia.desktop (NVIDIA support) ---${NC}"

            # Waybar LLM service — create venv if missing
            local llm_venv="$HOME/.config/waybar/llm/.venv"
            if [[ ! -d "$llm_venv" ]]; then
                echo -e "${BLUE}--- Creating waybar LLM venv ---${NC}"
                uv venv "$llm_venv" --python 3.12
            else
                echo -e "${GREEN}- Waybar LLM venv already exists, skipping${NC}"
            fi
            sudo cp "$full_desktop" "$ly_custom/sway-nvidia.desktop"
        fi
    fi
}

setup_node() {
    echo -e "${BLUE}--- Setting up Node.js with fnm ---${NC}"

    # Initialize fnm environment (explicitly bash to avoid fish syntax if $SHELL is fish)
    echo -e "- Initializing fnm environment..."
    eval "$(fnm env --shell bash --use-on-cd)"

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

    # Install Claude Code via the native installer
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

setup_neovim_tooling() {
    echo -e "${BLUE}--- Setting up Neovim Tooling ---${NC}"

    # tree-sitter CLI is installed via pacman; verify it's available
    if command -v tree-sitter &> /dev/null; then
        echo -e "${GREEN}- tree-sitter CLI already installed, skipping${NC}"
    else
        echo -e "${RED}- tree-sitter CLI not found. Install via: sudo pacman -S tree-sitter-cli${NC}"
    fi
}

show_post_install_notes() {
    echo -e "\n${GREEN}=== Setup Complete! ===${NC}"
    echo -e "\n${YELLOW}Post-installation notes:${NC}"
    echo -e "1. Keep fish as your LOGIN shell (CachyOS default) for compatibility."
    echo -e "   Do NOT chsh to nushell. Nushell is the interactive shell and is launched"
    echo -e "   inside the terminal via alacritty's [terminal.shell] program = \"nu\"."
    echo -e "2. Neovim and Nushell configs are linked and ready to use"
    echo -e "3. If WezTerm wasn't available via pacman, install it via an AUR helper:"
    echo -e "     paru -S wezterm  (or your preferred AUR helper)"
    echo -e "4. Run the hardware/disk-specific setup scripts manually (NOT run by this"
    echo -e "   script; both need sudo):"
    echo -e "     ./scripts/setup-data-mount.sh        # mounts the data-ssd (LUKS ext4)"
    echo -e "     ./scripts/setup-nvidia-powerlimit.sh # installs nvidia-powerlimit.service (280W)"
}

# Main execution
main() {
    echo -e "${GREEN}=== CachyOS Dotfiles Setup ===${NC}"

    install_deps
    setup_node
    setup_neovim_tooling
    setup_coding_agents
    setup_git
    setup_links
    show_post_install_notes
}

# Check if script is being sourced or executed
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
