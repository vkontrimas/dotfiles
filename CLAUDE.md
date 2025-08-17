# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a personal dotfiles repository for cross-platform development environments, supporting both Windows and macOS. The repository contains configuration files and setup scripts for a development environment centered around Nushell, Alacritty, Neovim, and modern CLI tools.

## Setup Commands

### Windows Setup
```powershell
.\Setup.ps1
```
- Installs Scoop package manager and dependencies
- Sets up Node.js via fnm
- Installs Claude Code via npm
- Creates MSVC environment cache for Rust/C++ development
- Links configuration directories via symbolic links
- Requires elevated privileges for font installation and symlink creation

### macOS Setup
```bash
./setup-mac.sh [--force]
```
- Installs Homebrew and dependencies
- Sets up Node.js via fnm
- Installs Claude Code via npm
- Links configuration directories
- Use `--force` to overwrite existing configurations

## Architecture

### Configuration Structure
- `alacritty/` - Terminal emulator configuration with Ayu Dark theme
- `git/` - Git aliases and configuration (included via global gitconfig)
- `nu/` - Nushell shell configuration with cross-platform environment setup
- `nvim/` - Neovim configuration
- `iterm2/` - macOS iTerm2 profile configuration

### Platform-Specific Behavior
The Nushell configuration (`nu/config.nu`) handles platform detection and environment setup:
- **Windows**: Loads cached MSVC environment variables for development
- **macOS**: Configures Homebrew paths and environment
- **Cross-platform**: Sets up fnm for Node.js version management and Cargo paths

### Key Features
- Automatic Node.js version switching via fnm (triggered by `.nvmrc`, `.node-version`, or `package.json`)
- MSVC toolchain integration on Windows for Rust/C++ development
- Git configuration with useful aliases and consistent branch naming
- Modern CLI tools: fd, eza, bat, fzf, ripgrep
- Nerd Font support (Hurmit) for terminal icons

## Development Environment

The setup installs and configures:
- **Shell**: Nushell with custom configuration
- **Terminal**: Alacritty (Windows/Linux) or iTerm2 (macOS)
- **Editor**: Neovim
- **Node.js**: Managed via fnm
- **Package Managers**: Scoop (Windows), Homebrew (macOS)
- **Development Tools**: Git, Claude Code, modern Unix tools

### Available CLI Tools
The following modern CLI tools are installed and available:
- **fd** - Fast file finder (use instead of `find`)
- **rg** (ripgrep) - Fast text search (use instead of `grep`)
- **eza** - Modern `ls` replacement
- **bat** - Syntax-highlighted `cat` replacement
- **fzf** - Fuzzy finder for interactive selection
- **tre** - Modern `tree` replacement with improved display
- **delta** - Syntax-highlighted pager for git diffs

### Important Environment Variables
- Windows: `MSVC_ENV_CACHE` path for C++/Rust toolchain
- Cross-platform: `FNM_MULTISHELL_PATH` for Node.js version management
- PATH extensions for Cargo, Homebrew, and fnm-managed Node.js versions