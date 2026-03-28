<#
.SYNOPSIS
    Termote online installer for Windows
.DESCRIPTION
    Downloads and installs Termote from GitHub releases.
.NOTES
    If script execution is disabled on your system, run this first:
    Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
.EXAMPLE
    # Download and run (PowerShell):
    irm https://raw.githubusercontent.com/lamngockhuong/termote/main/scripts/get.ps1 | iex

    # With options:
    $env:TERMOTE_MODE = "container"; irm .../get.ps1 | iex
    $env:TERMOTE_AUTO_YES = "true"; irm .../get.ps1 | iex
#>

[CmdletBinding()]
param(
    [switch]$Yes,
    [switch]$DownloadOnly,
    [switch]$Update,
    [ValidateSet("container", "native", "")]
    [string]$Mode = "",
    [switch]$Lan,
    [switch]$NoAuth
)

$ErrorActionPreference = "Stop"

# Configuration
$script:REPO = "lamngockhuong/termote"
$script:INSTALL_DIR = if ($env:TERMOTE_INSTALL_DIR) { $env:TERMOTE_INSTALL_DIR } else { Join-Path $env:USERPROFILE ".termote" }
$script:CONFIG_FILE = Join-Path $env:USERPROFILE ".termote\config.json"

# Check environment variables for options (for piped execution)
if ($env:TERMOTE_AUTO_YES -eq "true") { $Yes = $true }
if ($env:TERMOTE_DOWNLOAD_ONLY -eq "true") { $DownloadOnly = $true }
if ($env:TERMOTE_UPDATE -eq "true") { $Update = $true }
if ($env:TERMOTE_MODE) { $Mode = $env:TERMOTE_MODE }
if ($env:TERMOTE_LAN -eq "true") { $Lan = $true }
if ($env:TERMOTE_NO_AUTH -eq "true") { $NoAuth = $true }

# Update mode implies auto-yes
if ($Update) { $Yes = $true }

# UI Helpers
function Write-Info { param([string]$Message) Write-Host "[INFO] $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "[WARN] $Message" -ForegroundColor Yellow }
function Write-Err { param([string]$Message) Write-Host "[ERROR] $Message" -ForegroundColor Red; exit 1 }

# Load saved config for -Update mode
function Get-SavedConfig {
    if (-not (Test-Path $script:CONFIG_FILE)) {
        Write-Err "No saved config found. Run 'termote.ps1 install' first."
    }
    try {
        return Get-Content $script:CONFIG_FILE -Raw | ConvertFrom-Json
    } catch {
        Write-Err "Could not load config: $_"
    }
}

# Get installed version
function Get-InstalledVersion {
    $script = Join-Path $script:INSTALL_DIR "scripts\termote.ps1"
    if (Test-Path $script) {
        $content = Get-Content $script -Raw
        if ($content -match '\$script:VERSION\s*=\s*"([^"]+)"') {
            return $matches[1]
        }
    }
    return $null
}

# Get latest version from GitHub
function Get-LatestVersion {
    try {
        $release = Invoke-RestMethod "https://api.github.com/repos/$script:REPO/releases/latest"
        return $release.tag_name -replace '^v', ''
    } catch {
        Write-Err "Failed to get latest version: $_"
    }
}

# Check if services are running
function Test-ServicesRunning {
    $ttyd = Get-Process ttyd -ErrorAction SilentlyContinue
    $api = Get-Process tmux-api -ErrorAction SilentlyContinue
    return ($null -ne $ttyd) -or ($null -ne $api)
}

# Stop services
function Stop-Services {
    $script = Join-Path $script:INSTALL_DIR "scripts\termote.ps1"
    if (Test-Path $script) {
        Write-Info "Stopping running services..."
        try {
            & $script uninstall all 2>&1 | Out-Null
        } catch {}
    }
}

# Prompt for confirmation
function Confirm-Install {
    param(
        [string]$Current,
        [string]$Latest
    )

    Write-Host ""
    if ($Current) {
        if ($Current -eq $Latest) {
            Write-Info "Current version: v$Current (same as latest)"
            $prompt = "Re-install? [y/N]"
        } else {
            Write-Info "Current version: v$Current"
            Write-Info "Latest version:  v$Latest"
            $prompt = "Update to v${Latest}? [y/N]"
        }
    } else {
        Write-Info "Latest version: v$Latest"
        $prompt = "Install Termote? [y/N]"
    }

    $response = Read-Host $prompt
    return $response -match '^[Yy]'
}

# Verify checksum
function Test-Checksum {
    param(
        [string]$File,
        [string]$Expected
    )

    $actual = (Get-FileHash $File -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $Expected.ToLower()) {
        Write-Err "Checksum mismatch! Expected: $Expected, Got: $actual"
    }
    Write-Info "Checksum verified"
}

# Main
function Main {
    Write-Host ""
    Write-Host "  TERMOTE Installer (Windows)" -ForegroundColor Blue
    Write-Host ""
    Write-Info "Install path: $script:INSTALL_DIR"

    # Get versions
    $currentVersion = Get-InstalledVersion
    $latestVersion = Get-LatestVersion
    if (-not $latestVersion) {
        Write-Err "Failed to get latest version"
    }

    # Prompt before download (unless -Yes or -DownloadOnly)
    if (-not $Yes -and -not $DownloadOnly) {
        if (-not (Confirm-Install -Current $currentVersion -Latest $latestVersion)) {
            Write-Info "Cancelled."
            exit 0
        }
    }

    # Stop services if running
    if (Test-ServicesRunning) {
        Write-Warn "Services are running"
        if ($Yes) {
            Stop-Services
        } else {
            $response = Read-Host "Stop services before update? [Y/n]"
            if ($response -match '^[Nn]') {
                Write-Err "Cannot update while services are running. Stop manually: .\scripts\termote.ps1 uninstall all"
            }
            Stop-Services
        }
    }

    # Create install directory
    if (-not (Test-Path $script:INSTALL_DIR)) {
        New-Item -ItemType Directory -Path $script:INSTALL_DIR -Force | Out-Null
    }
    Push-Location $script:INSTALL_DIR

    try {
        # Download tarball
        $tarball = "termote-v${latestVersion}.tar.gz"
        $tarballUrl = "https://github.com/$script:REPO/releases/download/v${latestVersion}/$tarball"
        $checksumsUrl = "https://github.com/$script:REPO/releases/download/v${latestVersion}/checksums.txt"

        Write-Info "Downloading $tarball..."
        Invoke-WebRequest -Uri $tarballUrl -OutFile $tarball -UseBasicParsing

        # Verify checksum
        Write-Info "Verifying checksum..."
        try {
            $checksums = (Invoke-WebRequest -Uri $checksumsUrl -UseBasicParsing).Content
            $expectedLine = $checksums -split "`n" | Where-Object { $_ -match $tarball }
            if ($expectedLine) {
                $expected = ($expectedLine -split '\s+')[0]
                Test-Checksum -File $tarball -Expected $expected
            } else {
                Write-Warn "Checksum not found for $tarball, skipping verification"
            }
        } catch {
            Write-Warn "Could not download checksums, skipping verification"
        }

        # Extract
        Write-Info "Extracting..."
        # Use tar (available in Windows 10+)
        tar -xzf $tarball --strip-components=1
        Remove-Item $tarball -ErrorAction SilentlyContinue

        # Download only mode - stop here
        if ($DownloadOnly) {
            Write-Info "Download complete. Files extracted to: $script:INSTALL_DIR"
            Write-Info "To install manually: cd $script:INSTALL_DIR; .\scripts\termote.ps1 install [native|container]"
            return
        }

        # Run termote CLI
        Write-Info "Running installer..."

        # -Update mode: load saved config
        if ($Update) {
            $savedConfig = Get-SavedConfig
            if (-not $Mode) { $Mode = $savedConfig.Mode }
            if ($savedConfig.Lan) { $Lan = $true }
            if ($savedConfig.NoAuth) { $NoAuth = $true }
            Write-Info "Using saved config (mode: $Mode)"
        }

        # Default to native if no mode specified
        if (-not $Mode) { $Mode = "native" }

        $installArgs = @("install", $Mode)
        if ($Lan) { $installArgs += "-Lan" }
        if ($NoAuth) { $installArgs += "-NoAuth" }

        & ".\scripts\termote.ps1" @installArgs

    } finally {
        Pop-Location
    }
}

Main
