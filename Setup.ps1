param(
    [string]$Action
)

# Colors for output
$script:RED = "`e[31m"
$script:GREEN = "`e[32m" 
$script:YELLOW = "`e[33m"
$script:BLUE = "`e[34m"
$script:NC = "`e[0m" # No Color

function Write-ColorHost {
    param(
        [string]$Message,
        [string]$Color = $script:NC
    )
    Write-Host "${Color}${Message}${script:NC}"
}

function prompt-user {
    param(
        [string]$Message
    )
    
    do {
        $response = Read-Host "${script:YELLOW}$Message (y/n): ${script:NC}"
        $response = $response.ToLower()
    } while ($response -ne "y" -and $response -ne "n")
    
    return $response -eq "y"
}

function install-scoop {
    if (Get-Command scoop -ErrorAction SilentlyContinue) {
        Write-ColorHost "--- Scoop already installed, skipping ---" $script:GREEN
        return
    }
    
    Write-ColorHost "--- Installing Scoop ---" $script:BLUE
    Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
    Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression
}

function install-deps {
    Write-ColorHost "--- Installing Dependencies ---" $script:BLUE
    scoop bucket add extras
    scoop install @(
        "fnm"

        "fd"
        "eza"
        "bat"
        "fzf"
        "ripgrep"

        "alacritty"
        "neovim"
        "nu"
    )
}

function setup-alacritty-context-menu {
    Write-ColorHost "--- Setting up Alacritty Context Menu ---" $script:BLUE
    
    $regFile = "$env:USERPROFILE\scoop\apps\alacritty\current\install-context.reg"
    
    if (Test-Path $regFile) {
        Write-Host "- Importing Alacritty context menu registry entries..."
        reg import $regFile
        Write-ColorHost "- Alacritty context menu setup complete!" $script:GREEN
    } else {
        Write-Host "- Registry file not found: $regFile"
        Write-ColorHost "- Skipping context menu setup" $script:YELLOW
    }
}

function install-fonts-elevated {
    Write-ColorHost "--- Installing Hermit Nerd Font ---" $script:BLUE
    
    # Check if Hermit fonts are already installed
    $fontsPath = "$env:WINDIR\Fonts"
    $hermitFonts = Get-ChildItem -Path $fontsPath -Filter "*Hermit*" -ErrorAction SilentlyContinue
    
    if ($hermitFonts.Count -gt 0) {
        Write-ColorHost "- Hermit fonts already installed:" $script:GREEN
        $hermitFonts | ForEach-Object { Write-ColorHost "  $($_.Name)" $script:GREEN }
        
        if (!(prompt-user "Do you want to reinstall the fonts?")) {
            Write-ColorHost "- Skipping font installation" $script:YELLOW
            return
        }
    }
    
    $fontUrl = "https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/Hermit.zip"
    $tempDir = Join-Path $env:TEMP "hermit-font"
    $zipPath = Join-Path $tempDir "Hermit.zip"
    
    # Create temp directory
    if (!(Test-Path $tempDir)) {
        New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    }
    
    # Download font
    Write-Host "- Downloading Hermit Nerd Font..."
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
    
    Write-ColorHost "- Hermit Nerd Font installation complete!" $script:GREEN
}

function run-elevated-tasks {
    Write-ColorHost "--- Running Elevated Tasks ---" $script:BLUE
    
    # Launch elevated PowerShell for both font installation and linking
    $dotfilesDir = $PSScriptRoot
    $scriptPath = Join-Path $dotfilesDir "Setup.ps1"
    
    Start-Process powershell -ArgumentList "-Command", "& '$scriptPath' --elevated-tasks" -Verb RunAs -Wait
}

function upgrade-scoop {
    Write-ColorHost "--- Upgrading Scoop and Packages ---" $script:BLUE
    
    # Update scoop itself
    Write-Host "- Updating scoop..."
    scoop update
    
    # Update all installed packages
    Write-Host "- Updating installed packages..."
    scoop update *
    
    Write-ColorHost "- Scoop upgrade complete!" $script:GREEN
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
    Write-ColorHost "--- Linking $dirName ---" $script:BLUE
    
    if (Test-Path $Destination) {
        Write-ColorHost "- Symlink already exists: $Destination, skipping" $script:GREEN
        return
    }
    
    $destinationDir = Split-Path $Destination -Parent
    if (!(Test-Path $destinationDir)) {
        Write-ColorHost "--- Creating directory: $destinationDir ---" $script:BLUE
        New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
    }
    
    Write-ColorHost "--- Creating symlink: $fullSource -> $Destination ---" $script:BLUE
    New-Item -ItemType SymbolicLink -Path $Destination -Target $fullSource | Out-Null
}

function setup-git {
    Write-ColorHost "--- Setting up Git configuration ---" $script:BLUE
    
    # Add include directive to global gitconfig if not already present
    $includeCheck = git config --global --get-all include.path | Where-Object { $_ -like "*dotfiles/git/gitconfig*" }
    
    if (!$includeCheck) {
        Write-Host "- Adding dotfiles git config include..."
        git config --global include.path "~/dotfiles/git/gitconfig"
        Write-ColorHost "- Git configuration setup complete!" $script:GREEN
    } else {
        Write-ColorHost "- Git configuration already setup, skipping" $script:GREEN
    }
}

function setup-links-elevated {
    Write-ColorHost "--- Linking dotfiles ---" $script:BLUE
    
    link-dir "alacritty" "$env:APPDATA\alacritty"
    link-dir "nvim" "$env:LOCALAPPDATA\nvim"
    link-dir "nu" "$env:APPDATA\nushell"
}

function setup-node {
    Write-ColorHost "--- Setting up Node.js with fnm ---" $script:BLUE
    
    # Initialize fnm environment
    Write-Host "- Initializing fnm environment..."
    fnm env --use-on-cd | Out-String | Invoke-Expression
    
    # Install latest LTS Node.js
    Write-Host "- Installing latest LTS Node.js..."
    fnm install --lts
    fnm use lts-latest
    fnm default lts-latest
    
    Write-ColorHost "- Node.js setup complete!" $script:GREEN
    node --version
    npm --version
}

function setup-claude-code {
    Write-ColorHost "--- Installing Claude Code ---" $script:BLUE
    
    # Check if Claude Code is already installed
    if (Get-Command claude -ErrorAction SilentlyContinue) {
        Write-ColorHost "- Claude Code already installed, skipping" $script:GREEN
        return
    }
    
    # Install Claude Code via npm
    Write-Host "- Installing Claude Code via npm..."
    npm install -g @anthropic/claude-code
    
    Write-ColorHost "- Claude Code installation complete!" $script:GREEN
    claude --version
}


# Handle elevated execution with parameters
if ($Action -eq "--elevated-tasks") {
    install-fonts-elevated
    setup-links-elevated
    Write-Host 'Press any key to continue...'
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    exit
}
else {
    # Normal execution - run all steps
    Write-ColorHost "=== Windows Dotfiles Setup ===" $script:GREEN
    
    install-scoop
    install-deps
    upgrade-scoop
    setup-node
    setup-claude-code
    setup-git
    setup-alacritty-context-menu
    run-elevated-tasks
}
