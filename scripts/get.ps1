<#
.SYNOPSIS
    Termote online installer for Windows
.DESCRIPTION
    Downloads a release from GitHub, verifies its checksum, extracts it and
    hands over to the termote CLI, which does the install.
.NOTES
    If script execution is disabled on your system, run this first:
    Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
.EXAMPLE
    # Download and run (PowerShell):
    irm https://raw.githubusercontent.com/lamngockhuong/termote/main/scripts/get.ps1 | iex

    # With options:
    $env:TERMOTE_MODE = "container"; irm .../get.ps1 | iex
    $env:TERMOTE_AUTO_YES = "true"; irm .../get.ps1 | iex
    $env:TERMOTE_UPDATE = "true"; irm .../get.ps1 | iex
#>

[CmdletBinding()]
param(
    [switch]$Yes,
    [switch]$DownloadOnly,
    [switch]$Update,
    [ValidateSet("container", "native", "")]
    [string]$Mode = "",
    [switch]$Lan,
    [switch]$NoAuth,
    # Removed in 1.0.0; accepted and ignored.
    [string]$Ttyd = ""
)

$ErrorActionPreference = "Stop"

# Configuration
$script:REPO = "lamngockhuong/termote"
$script:INSTALL_DIR = if ($env:TERMOTE_INSTALL_DIR) { $env:TERMOTE_INSTALL_DIR } else { Join-Path $env:USERPROFILE ".termote" }
$script:CONFIG_FILE = Join-Path (Join-Path $env:USERPROFILE ".termote") "config.json"

# Environment variables carry the options for piped execution
if ($env:TERMOTE_AUTO_YES -eq "true") { $Yes = $true }
if ($env:TERMOTE_DOWNLOAD_ONLY -eq "true") { $DownloadOnly = $true }
if ($env:TERMOTE_UPDATE -eq "true") { $Update = $true }
if ($env:TERMOTE_MODE) { $Mode = $env:TERMOTE_MODE }
if ($env:TERMOTE_LAN -eq "true") { $Lan = $true }
if ($env:TERMOTE_NO_AUTH -eq "true") { $NoAuth = $true }
if ($env:TERMOTE_TTYD) { $Ttyd = $env:TERMOTE_TTYD }

# Update mode implies auto-yes
if ($Update) { $Yes = $true }

# UI Helpers
function Write-Info { param([string]$Message) Write-Host "[INFO] $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "[WARN] $Message" -ForegroundColor Yellow }
function Write-Err { param([string]$Message) Write-Host "[ERROR] $Message" -ForegroundColor Red; $script:HandledError = $true; throw }

# Installed version, from the .version file an install writes
function Get-InstalledVersion {
    $versionFile = Join-Path $script:INSTALL_DIR ".version"
    if (Test-Path $versionFile) {
        return (Get-Content $versionFile -Raw).Trim()
    }
    return $null
}

function Get-LatestVersion {
    try {
        $release = Invoke-RestMethod "https://api.github.com/repos/$script:REPO/releases/latest"
        return $release.tag_name -replace '^v', ''
    } catch {
        Write-Err "Failed to get latest version: $_"
    }
}

# Saved install mode, for -Update
function Get-SavedMode {
    if (-not (Test-Path $script:CONFIG_FILE)) {
        Write-Err "No saved config found. Run 'termote.ps1 install' first."
    }
    try {
        return (Get-Content $script:CONFIG_FILE -Raw | ConvertFrom-Json).Mode
    } catch {
        Write-Err "Could not load config: $_"
    }
}

function Confirm-Install {
    param([string]$Current, [string]$Latest)
    Write-Host ""
    if (-not $Current) {
        Write-Info "Latest version: v$Latest"
        $prompt = "Install Termote? [y/N]"
    } elseif ($Current -eq $Latest) {
        Write-Info "Current version: v$Current (same as latest)"
        $prompt = "Re-install? [y/N]"
    } else {
        Write-Info "Current version: v$Current"
        Write-Info "Latest version:  v$Latest"
        $prompt = "Update to v${Latest}? [y/N]"
    }
    return (Read-Host $prompt) -match '^[Yy]'
}

# Verify the tarball against checksums.txt; a missing list only warns, as in 0.x.
function Test-Checksum {
    param([string]$File, [string]$Name, [string]$Url)
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing
    } catch {
        Write-Warn "Could not download checksums, skipping verification"
        return
    }
    $checksums = if ($response.Content -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($response.Content) } else { $response.Content }
    $line = $checksums -split '\r?\n' | Where-Object { ($_ -split '\s+')[1] -in @($Name, "*$Name") } | Select-Object -First 1
    if (-not $line) {
        Write-Warn "Checksum not found for $Name, skipping verification"
        return
    }
    $expected = ($line -split '\s+')[0]
    $actual = (Get-FileHash $File -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected.ToLower()) {
        Write-Err "Checksum mismatch! Expected: $expected, Got: $actual"
    }
    Write-Info "Checksum verified"
}

function Main {
    Write-Host ""
    Write-Host "  TERMOTE Installer (Windows)" -ForegroundColor Blue
    Write-Host ""
    Write-Info "Install path: $script:INSTALL_DIR"
    if ($Ttyd) { Write-Warn "TERMOTE_TTYD/-Ttyd is ignored: ttyd was removed in 1.0.0" }

    $currentVersion = Get-InstalledVersion
    $latestVersion = Get-LatestVersion
    if (-not $latestVersion) {
        Write-Err "Failed to get latest version"
    }

    if (-not $Yes -and -not $DownloadOnly) {
        if (-not (Confirm-Install -Current $currentVersion -Latest $latestVersion)) {
            Write-Info "Cancelled."
            return
        }
    }

    $tarball = "termote-v${latestVersion}.tar.gz"
    $base = "https://github.com/$script:REPO/releases/download/v${latestVersion}"
    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("termote-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    try {
        $file = Join-Path $tmpDir $tarball
        Write-Info "Downloading $tarball..."
        Invoke-WebRequest -Uri "$base/$tarball" -OutFile $file -UseBasicParsing
        Write-Info "Verifying checksum..."
        Test-Checksum -File $file -Name $tarball -Url "$base/checksums.txt"

        # Extract over the install dir (tar ships with Windows 10+). The saved
        # config lives outside the tarball, and `termote.ps1 install` stops
        # running services itself.
        Write-Info "Extracting..."
        if (-not (Test-Path $script:INSTALL_DIR)) {
            New-Item -ItemType Directory -Path $script:INSTALL_DIR -Force | Out-Null
        }
        tar -xzf $file --strip-components=1 -C $script:INSTALL_DIR
        if ($LASTEXITCODE -ne 0) { Write-Err "Extraction failed (tar exit $LASTEXITCODE)" }
        $latestVersion | Set-Content (Join-Path $script:INSTALL_DIR ".version") -NoNewline
    } finally {
        Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    $shim = Join-Path (Join-Path $script:INSTALL_DIR "scripts") "termote.ps1"
    if ($DownloadOnly) {
        Write-Info "Download complete. Files extracted to: $script:INSTALL_DIR"
        Write-Info "To install: & '$shim' install [native|container]"
        return
    }

    # `install` merges the saved config for every option not given here.
    if ($Update -and -not $Mode) {
        $Mode = Get-SavedMode
        Write-Info "Using saved config (mode: $Mode)"
    }
    if (-not $Mode) { $Mode = "native" }

    $installArgs = @{ Command = "install"; Mode = $Mode }
    if ($Lan) { $installArgs.Lan = $true }
    if ($NoAuth) { $installArgs.NoAuth = $true }

    Write-Info "Running installer..."
    & $shim @installArgs
    if ($LASTEXITCODE -ne 0) { Write-Err "Install failed (exit $LASTEXITCODE)" }
}

try { Main } catch {
    if (-not $script:HandledError) { throw $_ }
}
