param(
    [string]$Action
)

function prompt-user {
    param(
        [string]$Message
    )
    
    do {
        $response = Read-Host "$Message (y/n)"
        $response = $response.ToLower()
    } while ($response -ne "y" -and $response -ne "n")
    
    return $response -eq "y"
}

function install-scoop {
    if (Get-Command scoop -ErrorAction SilentlyContinue) {
        Write-Host "--- Scoop already installed, skipping ---"
        return
    }
    
    Write-Host "--- Installing Scoop ---"
    Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
    Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression
}

function install-deps {
    Write-Host "--- Installing Dependencies ---"
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
    Write-Host "--- Setting up Alacritty Context Menu ---"
    
    $regFile = "$env:USERPROFILE\scoop\apps\alacritty\current\install-context.reg"
    
    if (Test-Path $regFile) {
        Write-Host "- Importing Alacritty context menu registry entries..."
        reg import $regFile
        Write-Host "- Alacritty context menu setup complete!"
    } else {
        Write-Host "- Registry file not found: $regFile"
        Write-Host "- Skipping context menu setup"
    }
}

function install-fonts-elevated {
    Write-Host "--- Installing Hermit Nerd Font ---"
    
    # Check if Hermit fonts are already installed
    $fontsPath = "$env:WINDIR\Fonts"
    $hermitFonts = Get-ChildItem -Path $fontsPath -Filter "*Hermit*" -ErrorAction SilentlyContinue
    
    if ($hermitFonts.Count -gt 0) {
        Write-Host "- Hermit fonts already installed:"
        $hermitFonts | ForEach-Object { Write-Host "  $($_.Name)" }
        
        if (!(prompt-user "Do you want to reinstall the fonts?")) {
            Write-Host "- Skipping font installation"
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
    
    Write-Host "- Hermit Nerd Font installation complete!"
}

function run-elevated-tasks {
    Write-Host "--- Running Elevated Tasks ---"
    
    # Launch elevated PowerShell for both font installation and linking
    $dotfilesDir = $PSScriptRoot
    $scriptPath = Join-Path $dotfilesDir "Setup.ps1"
    
    Start-Process powershell -ArgumentList "-Command", "& '$scriptPath' --elevated-tasks" -Verb RunAs -Wait
}

function upgrade-scoop {
    Write-Host "--- Upgrading Scoop and Packages ---"
    
    # Update scoop itself
    Write-Host "- Updating scoop..."
    scoop update
    
    # Update all installed packages
    Write-Host "- Updating installed packages..."
    scoop update *
    
    Write-Host "- Scoop upgrade complete!"
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
    Write-Host "--- Linking $dirName ---"
    
    if (Test-Path $Destination) {
        Write-Host "- Link already exists: $Destination, skipping"
        return
    }
    
    $destinationDir = Split-Path $Destination -Parent
    if (!(Test-Path $destinationDir)) {
        Write-Host "--- Creating directory: $destinationDir ---"
        New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
    }
    
    Write-Host "--- Creating symlink: $fullSource -> $Destination ---"
    New-Item -ItemType SymbolicLink -Path $Destination -Target $fullSource | Out-Null
}

function setup-links-elevated {
    Write-Host "--- Linking dotfiles ---"
    
    link-dir "alacritty" "$env:APPDATA\alacritty"
    link-dir "nvim" "$env:LOCALAPPDATA\nvim"
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
    install-scoop
    install-deps
    upgrade-scoop
    setup-alacritty-context-menu
    run-elevated-tasks
}
