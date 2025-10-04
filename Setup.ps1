param(
    [string]$Action,
    [switch]$Force
)

function Write-ColorHost {
    param(
        [string]$Message,
        [string]$Color = "White"
    )
    Write-Host $Message -ForegroundColor $Color
}

function prompt-user {
    param(
        [string]$Message
    )
    
    do {
        Write-Host "$Message (y/n): " -ForegroundColor Yellow -NoNewline
        $response = Read-Host
        $response = $response.ToLower()
    } while ($response -ne "y" -and $response -ne "n")
    
    return $response -eq "y"
}

function install-scoop {
    if (Get-Command scoop -ErrorAction SilentlyContinue) {
        Write-ColorHost "--- Scoop already installed, skipping ---" "Green"
        return
    }
    
    Write-ColorHost "--- Installing Scoop ---" "Blue"
    Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
    Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression
}

function install-deps {
    Write-ColorHost "--- Installing Dependencies ---" "Blue"
    scoop bucket add extras
    scoop install @(
        "fnm"

        "fd"
        "eza"
        "bat"
        "fzf"
        "ripgrep"
        "tre-command"
        "delta"

        "just"

        "alacritty"
        "neovim"
        "nu"
        "obsidian"
    )
}

function setup-alacritty-context-menu {
    Write-ColorHost "--- Setting up Alacritty Context Menu ---" "Blue"
    
    $regFile = "$env:USERPROFILE\scoop\apps\alacritty\current\install-context.reg"
    
    if (Test-Path $regFile) {
        Write-Host "- Importing Alacritty context menu registry entries..."
        reg import $regFile
        Write-ColorHost "- Alacritty context menu setup complete!" "Green"
    } else {
        Write-Host "- Registry file not found: $regFile"
        Write-ColorHost "- Skipping context menu setup" "Yellow"
    }
}

function install-fonts-elevated {
    Write-ColorHost "--- Installing Hurmit Nerd Font ---" "Blue"
    
    # Check if Hurmit fonts are already installed
    if (check-fonts-installed) {
        Write-ColorHost "- Hurmit fonts already installed, skipping" "Green"
        return
    }
    
    $fontUrl = "https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/Hermit.zip"
    $tempDir = Join-Path $env:TEMP "hermit-font"
    $zipPath = Join-Path $tempDir "Hurmit.zip"
    
    # Create temp directory
    if (!(Test-Path $tempDir)) {
        New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    }
    
    # Download font
    Write-Host "- Downloading Hurmit Nerd Font..."
    Invoke-WebRequest -Uri $fontUrl -OutFile $zipPath
    
    # Extract zip
    Write-Host "- Extracting fonts..."
    Expand-Archive -Path $zipPath -DestinationPath $tempDir -Force
    
    # Install fonts
    Write-Host "- Installing fonts..."
    $fontsPath = "$env:WINDIR\Fonts"
    $fontFiles = Get-ChildItem -Path $tempDir -Include "*.ttf", "*.otf" -Recurse
    
    $fontFiles | ForEach-Object {
        Write-Host "  Installing $($_.Name)"
        
        # Copy font to Windows Fonts directory
        Copy-Item -Path $_.FullName -Destination $fontsPath -Force
        
        # Register font in registry
        $fontName = $_.BaseName
        $fontFileName = $_.Name
        New-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts" -Name $fontName -Value $fontFileName -Force | Out-Null
    }
    
    # Cleanup
    Write-Host "- Cleaning up..."
    Remove-Item -Path $tempDir -Recurse -Force
    
    Write-ColorHost "- Hurmit Nerd Font installation complete!" "Green"
}

function check-fonts-installed {
    $fontsPath = "$env:WINDIR\Fonts"
    $hermitFonts = Get-ChildItem -Path $fontsPath -Filter "*Hurmit*" -ErrorAction SilentlyContinue
    return $hermitFonts.Count -gt 0
}

function run-elevated-tasks {
    Write-ColorHost "--- Running Elevated Tasks ---" "Blue"
    
    # Launch elevated PowerShell
    $dotfilesDir = $PSScriptRoot
    $scriptPath = Join-Path $dotfilesDir "Setup.ps1"
    Start-Process powershell -ArgumentList "-Command", "& '$scriptPath' --elevated-tasks" -Verb RunAs -Wait
}

function upgrade-scoop {
    Write-ColorHost "--- Upgrading Scoop and Packages ---" "Blue"
    
    # Update scoop itself
    Write-Host "- Updating scoop..."
    scoop update
    
    # Update all installed packages
    Write-Host "- Updating installed packages..."
    scoop update *
    
    Write-ColorHost "- Scoop upgrade complete!" "Green"
}

function link-dir {
    param(
        [string]$Source,
        [string]$Destination
    )
    
    # Prepend dotfilesDir to source path
    $dotfilesDir = $PSScriptRoot
    $fullSource = Join-Path $dotfilesDir $Source
    
    $dirName = Split-Path $fullSource -Leaf
    Write-ColorHost "--- Linking $dirName ---" "Blue"
    
    # Check if destination already exists
    if (Test-Path $Destination) {
        # Check if it's already a symlink pointing to the right place
        $item = Get-Item $Destination
        if ($item.LinkType -eq "SymbolicLink" -and $item.Target -eq $fullSource) {
            Write-ColorHost "- Symlink already exists and points to correct target: $Destination, skipping" "Green"
            return
        }
        
        if (!$Force) {
            Write-ColorHost "- Path already exists: $Destination, skipping (use -Force to overwrite)" "Yellow"
            return
        } else {
            Write-ColorHost "- Removing existing path: $Destination" "Yellow"
            Remove-Item -Path $Destination -Recurse -Force
        }
    }
    
    $destinationDir = Split-Path $Destination -Parent
    if (!(Test-Path $destinationDir)) {
        Write-ColorHost "--- Creating directory: $destinationDir ---" "Blue"
        New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
    }
    
    Write-ColorHost "--- Creating symlink: $fullSource -> $Destination ---" "Blue"
    New-Item -ItemType SymbolicLink -Path $Destination -Target $fullSource | Out-Null
}

function setup-git {
    Write-ColorHost "--- Setting up Git configuration ---" "Blue"
    
    # Add include directive to global gitconfig if not already present
    $includeCheck = git config --global --get-all include.path | Where-Object { $_ -like "*dotfiles/git/gitconfig*" }
    
    if (!$includeCheck) {
        Write-Host "- Adding dotfiles git config include..."
        git config --global include.path "~/dotfiles/git/gitconfig"
        Write-ColorHost "- Git configuration setup complete!" "Green"
    } else {
        Write-ColorHost "- Git configuration already setup, skipping" "Green"
    }
}

function setup-links-elevated {
    Write-ColorHost "--- Linking dotfiles ---" "Blue"
    
    link-dir "alacritty" "$env:APPDATA\alacritty"
    link-dir "nvim" "$env:LOCALAPPDATA\nvim"
    link-dir "nu" "$env:APPDATA\nushell"
}

function setup-node {
    Write-ColorHost "--- Setting up Node.js with fnm ---" "Blue"
    
    # Initialize fnm environment
    Write-Host "- Initializing fnm environment..."
    fnm env --use-on-cd | Out-String | Invoke-Expression
    
    # Install latest LTS Node.js
    Write-Host "- Installing latest LTS Node.js..."
    fnm install --lts
    fnm use lts-latest
    fnm default lts-latest
    
    Write-ColorHost "- Node.js setup complete!" "Green"
    node --version
    npm --version
}

function setup-claude-code {
    Write-ColorHost "--- Installing Claude Code ---" "Blue"
    
    # Check if Claude Code is already installed
    if (Get-Command claude -ErrorAction SilentlyContinue) {
        Write-ColorHost "- Claude Code already installed, skipping" "Green"
        return
    }
    
    # Install Claude Code via npm
    Write-Host "- Installing Claude Code via npm..."
    npm install -g '@anthropic-ai/claude-code'
    
    Write-ColorHost "- Claude Code installation complete!" "Green"
    claude --version
}

function setup-msvc-environment {
    Write-ColorHost "--- Finding MSVC environment variables ---" "Blue"
    
    # Find vcvarsall.bat (prefer Enterprise > Professional > Community, 2022 > 2019)
    $vcvarsallPaths = @(
        "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvarsall.bat",
        "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvarsall.bat",
        "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat",
        "C:\Program Files\Microsoft Visual Studio\2019\Enterprise\VC\Auxiliary\Build\vcvarsall.bat",
        "C:\Program Files\Microsoft Visual Studio\2019\Professional\VC\Auxiliary\Build\vcvarsall.bat",
        "C:\Program Files\Microsoft Visual Studio\2019\Community\VC\Auxiliary\Build\vcvarsall.bat"
    )
    
    $vcvarsall = $vcvarsallPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
    
    if ($vcvarsall) {
        Write-ColorHost "- Found MSVC at: $vcvarsall" "Green"
        
        # Create batch file to capture environment
        $tempBat = "$env:USERPROFILE\msvc_setup.bat"
        $cacheFile = "$env:USERPROFILE\.msvc_env_cache"
        
        @"
@echo off
call "$vcvarsall" x64 > nul
set > "$cacheFile"
"@ | Out-File -FilePath $tempBat -Encoding ASCII
        
        # Run batch file to generate cache
        cmd /c $tempBat
        
        if (Test-Path $cacheFile) {
            Write-ColorHost "- MSVC environment cache created successfully" "Green"
        } else {
            Write-ColorHost "- Failed to create MSVC environment cache" "Red"
        }
        
        # Clean up temp file
        Remove-Item $tempBat -ErrorAction SilentlyContinue
    } else {
        Write-ColorHost "- No MSVC installation found" "Yellow"
    }
}


# Handle elevated execution with parameters
if ($Action -eq "--elevated-tasks") {
    # Check if fonts are installed
    if (check-fonts-installed) {
        Write-ColorHost "--- Hurmit fonts already installed, skipping font installation ---" "Green"
    } else {
        install-fonts-elevated
    }
    setup-links-elevated
    Write-Host 'Press any key to continue...'
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    exit
}
else {
    # Normal execution - run all steps
    Write-ColorHost "=== Windows Dotfiles Setup ===" "Green"
    
    install-scoop
    install-deps
    upgrade-scoop
    setup-node
    setup-claude-code
    setup-msvc-environment
    setup-git
    setup-alacritty-context-menu
    run-elevated-tasks
}
