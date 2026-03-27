<#
.SYNOPSIS
    Termote CLI - unified management tool for Windows
.DESCRIPTION
    Windows PowerShell CLI for remotely controlling terminal from mobile/desktop.
    Supports container mode (Docker/Podman Desktop) and native mode (psmux + ttyd).
.EXAMPLE
    .\termote.ps1                           # Interactive menu
    .\termote.ps1 install container         # Container mode
    .\termote.ps1 install container -Lan    # Container + LAN access
    .\termote.ps1 install native            # Native mode (psmux)
    .\termote.ps1 uninstall all             # Full cleanup
    .\termote.ps1 health                    # Check services
    .\termote.ps1 link                      # Create 'termote' global command
    .\termote.ps1 unlink                    # Remove global command
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("install", "uninstall", "health", "logs", "link", "unlink", "help", "")]
    [string]$Command,

    [Parameter(Position = 1)]
    [ValidateSet("container", "native", "all", "")]
    [string]$Mode,

    [switch]$Lan,
    [switch]$NoAuth,
    [int]$Port = 7680,
    [string]$Tailscale
)

# =============================================================================
# CONFIGURATION
# =============================================================================

$script:VERSION = "0.0.4"
$script:SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:PROJECT_DIR = Split-Path -Parent $script:SCRIPT_DIR
$script:PORT_MAIN = 7680
$script:PORT_TTYD = 7681
$script:CONTAINER_NAME = "termote"
$script:HOME_DIR = if ($env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME }
$script:LOG_DIR = Join-Path $script:HOME_DIR ".termote/logs"

# Check if gum is available for fancy UI
$script:HAS_GUM = $null -ne (Get-Command gum -ErrorAction SilentlyContinue)

# =============================================================================
# UI HELPERS
# =============================================================================

function Write-Info { param([string]$Message) Write-Host "[INFO] $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "[WARN] $Message" -ForegroundColor Yellow }
function Write-Err { param([string]$Message) Write-Host "[ERROR] $Message" -ForegroundColor Red; exit 1 }
function Write-Step { param([string]$Step, [string]$Message) Write-Host "[$Step] $Message" -ForegroundColor Cyan }

function Show-Header {
    Write-Host ""
    Write-Host "  TERMOTE - Terminal + Remote" -ForegroundColor Blue
    Write-Host "  Windows CLI v$script:VERSION" -ForegroundColor DarkGray
    Write-Host ""
}

# =============================================================================
# COMMON FUNCTIONS
# =============================================================================

function Get-ContainerRuntime {
    if (Get-Command podman -ErrorAction SilentlyContinue) {
        return "podman"
    }
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        return "docker"
    }
    Write-Err "Neither podman nor docker found. Please install Docker Desktop or Podman Desktop."
}

function Get-LanIP {
    try {
        $ip = (Get-NetIPAddress -AddressFamily IPv4 |
            Where-Object { $_.InterfaceAlias -notmatch "Loopback" -and $_.IPAddress -notmatch "^169\." } |
            Select-Object -First 1).IPAddress
        if ($ip) { return $ip }
    } catch {}
    return "0.0.0.0"
}

function Test-ValidIP {
    param([string]$IP)
    return $IP -match "^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$"
}

function Test-ValidPort {
    param([int]$Port)
    return $Port -ge 1 -and $Port -le 65535
}

function Setup-Auth {
    param([switch]$NoAuth)

    if ($NoAuth) {
        Write-Info "Basic auth disabled"
        $env:TERMOTE_PASS = ""
        $env:NO_AUTH = "true"
        return
    }

    $env:NO_AUTH = ""

    # Interactive password prompt
    if ([Environment]::UserInteractive) {
        $prompt = "Enter password for admin (Enter = auto-generate): "
        if ($script:HAS_GUM) {
            $pass = & gum input --password --placeholder "Leave empty to auto-generate" --header "Admin Password"
        } else {
            Write-Host $prompt -NoNewline
            $securePass = Read-Host -AsSecureString
            $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePass)
            try {
                $pass = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
            } finally {
                [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
            }
        }

        if ($pass) {
            $env:TERMOTE_PASS = $pass
            Write-Info "Using provided password"
        } else {
            $env:TERMOTE_PASS = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 12 | ForEach-Object { [char]$_ })
            Write-Info "Auto-generated password"
        }
    } else {
        # Non-interactive
        $env:TERMOTE_PASS = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 12 | ForEach-Object { [char]$_ })
        Write-Info "Auto-generated password"
    }
}

function Show-Credentials {
    param([string]$Password, [string]$Type = "auto-generated")

    Write-Host ""
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "  TERMOTE CREDENTIALS ($Type)"
    Write-Host "  Username: admin" -ForegroundColor White
    Write-Host "  Password: $Password" -ForegroundColor White
    Write-Host "  (credentials shown once, not logged)" -ForegroundColor DarkGray
    Write-Host "============================================" -ForegroundColor Cyan
}

function Show-AccessInfo {
    param(
        [int]$Port,
        [switch]$Lan,
        [string]$LanIP,
        [string]$Tailscale,
        [switch]$NoAuth
    )

    Write-Host ""
    Write-Host "=== Access Info ===" -ForegroundColor White

    if ($Tailscale) {
        $tsPort = if ($Tailscale -match ":") { ($Tailscale -split ":")[-1] } else { "443" }
        $tsHost = ($Tailscale -split ":")[0]
        Write-Host "Tailscale: https://${tsHost}:${tsPort}" -ForegroundColor Cyan
    }

    if ($Lan) {
        Write-Host "LAN: http://${LanIP}:${Port}" -ForegroundColor Cyan
    } elseif (-not $Tailscale) {
        Write-Host "Local: http://localhost:${Port}" -ForegroundColor Cyan
    }

    if (-not $NoAuth -and $env:TERMOTE_PASS) {
        Show-Credentials -Password $env:TERMOTE_PASS
    }
}

# =============================================================================
# INTERACTIVE MENU
# =============================================================================

function Select-Option {
    param(
        [string]$Header,
        [string[]]$Options
    )

    if ($script:HAS_GUM) {
        return & gum choose --header $Header @Options
    } else {
        Write-Host $Header -ForegroundColor Cyan
        Write-Host ""
        for ($i = 0; $i -lt $Options.Count; $i++) {
            Write-Host "  [$($i + 1)] $($Options[$i])"
        }
        Write-Host ""
        do {
            $choice = Read-Host "Select (1-$($Options.Count))"
        } while (-not ($choice -match "^\d+$" -and [int]$choice -ge 1 -and [int]$choice -le $Options.Count))
        return $Options[[int]$choice - 1]
    }
}

function Confirm-Action {
    param([string]$Message)

    if ($script:HAS_GUM) {
        $null = & gum confirm $Message 2>&1
        return $LASTEXITCODE -eq 0
    } else {
        $yn = Read-Host "$Message [y/N]"
        return $yn -match "^[Yy]"
    }
}

function Show-InteractiveMenu {
    Show-Header

    $action = Select-Option -Header "Select action:" -Options @(
        "Install",
        "Uninstall",
        "Health check",
        "View logs",
        "Exit"
    )

    switch -Wildcard ($action) {
        "Install*" { Show-InteractiveInstall }
        "Uninstall*" { Show-InteractiveUninstall }
        "Health*" { Invoke-Health }
        "View logs*" { Invoke-Logs -Service "all" }
        default { exit 0 }
    }
}

function Show-InteractiveInstall {
    $mode = Select-Option -Header "Select mode:" -Options @(
        "container - Isolated container (Docker/Podman)",
        "native - Host tool access (psmux)"
    )
    $mode = ($mode -split " ")[0]

    $opts = @{}
    if (Confirm-Action "Expose to LAN?") { $opts.Lan = $true }
    if (Confirm-Action "Disable authentication?") { $opts.NoAuth = $true }
    if (Confirm-Action "Enable Tailscale HTTPS?") {
        if ($script:HAS_GUM) {
            $tsHost = & gum input --placeholder "Tailscale hostname (e.g. myhost.ts.net)"
        } else {
            $tsHost = Read-Host "Tailscale hostname (e.g. myhost.ts.net)"
        }
        if ($tsHost) { $opts.Tailscale = $tsHost }
    }

    Invoke-Install -Mode $mode @opts
}

function Show-InteractiveUninstall {
    $mode = Select-Option -Header "What to remove:" -Options @("container", "native", "all")
    Invoke-Uninstall -Mode $mode
}

# =============================================================================
# CONTAINER MODE
# =============================================================================

function Start-ContainerMode {
    param(
        [string]$BindAddr,
        [int]$Port
    )

    $runtime = Get-ContainerRuntime
    Write-Info "Using $runtime"

    # Validate inputs
    if (-not (Test-ValidIP $BindAddr)) { Write-Err "Invalid bind address: $BindAddr" }
    if (-not (Test-ValidPort $Port)) { Write-Err "Invalid port: $Port" }

    # Stop existing
    Push-Location $script:PROJECT_DIR
    try {
        & $runtime compose down 2>$null
    } catch {}

    # Create override file
    $override = @"
services:
  termote:
    ports:
      - "${BindAddr}:${Port}:$($script:PORT_MAIN)"
"@
    $override | Out-File -FilePath "docker-compose.override.yml" -Encoding utf8 -NoNewline

    # Start container
    & $runtime compose --profile docker up -d --build
    if ($LASTEXITCODE -ne 0) {
        Remove-Item "docker-compose.override.yml" -ErrorAction SilentlyContinue
        Write-Err "Failed to start container"
    }

    Remove-Item "docker-compose.override.yml" -ErrorAction SilentlyContinue
    Pop-Location
}

function Stop-ContainerMode {
    $runtime = $null
    if (Get-Command podman -ErrorAction SilentlyContinue) { $runtime = "podman" }
    elseif (Get-Command docker -ErrorAction SilentlyContinue) { $runtime = "docker" }

    if ($runtime) {
        Push-Location $script:PROJECT_DIR
        try {
            & $runtime compose --profile docker down -v 2>&1 | Out-Null
        } catch {
            Write-Warn "Cleanup warning: compose down failed"
        }
        try {
            & $runtime stop $script:CONTAINER_NAME 2>&1 | Out-Null
            & $runtime rm $script:CONTAINER_NAME 2>&1 | Out-Null
        } catch {
            # Container may not exist, ignore
        }
        Remove-Item "docker-compose.override.yml" -ErrorAction SilentlyContinue
        Pop-Location
    }
}

# =============================================================================
# NATIVE MODE (psmux + ttyd)
# =============================================================================

function Test-Psmux {
    if (-not (Get-Command tmux -ErrorAction SilentlyContinue)) {
        Write-Err @"
psmux not found. Install it:
  winget install psmux

Or from: https://github.com/psmux/psmux
"@
    }

    # Verify it's psmux (not WSL tmux)
    $version = & tmux -V 2>&1
    if ($version -notmatch "psmux") {
        Write-Warn "tmux found but may not be psmux. Proceeding anyway."
    }
}

function Get-TtydBinary {
    param([string]$DestDir)

    $ttydPath = Join-Path $DestDir "ttyd.exe"
    if (Test-Path $ttydPath) {
        return $ttydPath
    }

    Write-Info "Downloading ttyd.win32.exe..."
    try {
        $release = Invoke-RestMethod "https://api.github.com/repos/tsl0922/ttyd/releases/latest"
        $asset = $release.assets | Where-Object { $_.name -eq "ttyd.win32.exe" }
        if (-not $asset) { Write-Err "ttyd.win32.exe not found in release" }

        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $ttydPath
        return $ttydPath
    } catch {
        Write-Err "Failed to download ttyd: $_"
    }
}

function Start-PsmuxSession {
    param([string]$SessionName = "main")

    $exists = & tmux has-session -t $SessionName 2>&1
    if ($LASTEXITCODE -ne 0) {
        & tmux new-session -d -s $SessionName
    }
}

function Start-TtydProcess {
    param(
        [string]$TtydPath,
        [int]$Port = 7681
    )

    # Kill existing ttyd
    Get-Process ttyd -ErrorAction SilentlyContinue | Stop-Process -Force

    # Ensure log directory exists
    if (-not (Test-Path $script:LOG_DIR)) {
        New-Item -ItemType Directory -Path $script:LOG_DIR -Force | Out-Null
    }

    # Start ttyd with psmux
    $args = @("-W", "-i", "127.0.0.1", "-p", $Port, "tmux", "new-session", "-A", "-s", "main")
    Start-Process -FilePath $TtydPath -ArgumentList $args -WindowStyle Hidden -RedirectStandardOutput "$script:LOG_DIR\ttyd.log" -RedirectStandardError "$script:LOG_DIR\ttyd-error.log"
    Start-Sleep -Seconds 1
}

function Start-TmuxApiProcess {
    param(
        [string]$BinaryPath,
        [string]$PwaDir,
        [string]$BindAddr,
        [int]$Port,
        [switch]$NoAuth
    )

    # Kill existing
    Get-Process tmux-api -ErrorAction SilentlyContinue | Stop-Process -Force

    # Ensure log directory exists
    if (-not (Test-Path $script:LOG_DIR)) {
        New-Item -ItemType Directory -Path $script:LOG_DIR -Force | Out-Null
    }

    $env:TERMOTE_PORT = $Port
    $env:TERMOTE_BIND = $BindAddr
    $env:TERMOTE_PWA_DIR = $PwaDir
    $env:TERMOTE_USER = "admin"
    $env:TERMOTE_NO_AUTH = if ($NoAuth) { "true" } else { "" }

    Start-Process -FilePath $BinaryPath -WindowStyle Hidden -RedirectStandardOutput "$script:LOG_DIR\tmux-api.log" -RedirectStandardError "$script:LOG_DIR\tmux-api-error.log"
}

function Start-NativeMode {
    param(
        [string]$BindAddr,
        [int]$Port,
        [switch]$NoAuth
    )

    # Verify psmux
    Test-Psmux

    # Stop existing services
    Stop-NativeMode

    # Get/download ttyd
    $ttydPath = Get-TtydBinary -DestDir $script:SCRIPT_DIR

    # Find tmux-api binary
    $apiPath = Join-Path $script:PROJECT_DIR "tmux-api\tmux-api.exe"
    if (-not (Test-Path $apiPath)) {
        # Try native build
        $apiPath = Join-Path $script:PROJECT_DIR "tmux-api\tmux-api-native.exe"
    }
    if (-not (Test-Path $apiPath)) {
        Write-Err "tmux-api.exe not found. Build it first: cd tmux-api && go build -o tmux-api.exe ."
    }

    # PWA directory
    $pwaDir = Join-Path $script:PROJECT_DIR "pwa\dist"
    if (-not (Test-Path $pwaDir)) {
        Write-Err "PWA not built. Run: cd pwa && pnpm build"
    }

    # Start services
    Start-PsmuxSession
    Start-TtydProcess -TtydPath $ttydPath -Port $script:PORT_TTYD
    Start-TmuxApiProcess -BinaryPath $apiPath -PwaDir $pwaDir -BindAddr $BindAddr -Port $Port -NoAuth:$NoAuth

    Write-Info "Native mode started"
}

function Stop-NativeMode {
    Get-Process ttyd -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-Process tmux-api -ErrorAction SilentlyContinue | Stop-Process -Force
}

# =============================================================================
# COMMANDS
# =============================================================================

function Invoke-Install {
    param(
        [Parameter(Mandatory)]
        [ValidateSet("container", "native")]
        [string]$Mode,

        [switch]$Lan,
        [switch]$NoAuth,
        [int]$Port = 7680,
        [string]$Tailscale
    )

    $bindAddr = if ($Lan) { "0.0.0.0" } else { "127.0.0.1" }
    $lanIP = if ($Lan) { Get-LanIP } else { "" }

    # Check release mode
    $releaseMode = $false
    $pwaDist = Join-Path $script:PROJECT_DIR "pwa\dist"
    if (Test-Path (Join-Path $script:PROJECT_DIR "pwa-dist")) {
        $releaseMode = $true
        $pwaDist = Join-Path $script:PROJECT_DIR "pwa-dist"
        Write-Info "Release mode (using pre-built artifacts)"
    }

    Write-Host ""
    Write-Host "=== Termote Install ($Mode) ===" -ForegroundColor White
    Write-Host ""

    # Step 1: Setup PWA
    Write-Step "1/4" "Setting up PWA..."
    if ($releaseMode) {
        $destDir = Join-Path $script:PROJECT_DIR "pwa\dist"
        if (-not (Test-Path $destDir)) {
            New-Item -ItemType Directory -Path $destDir -Force | Out-Null
        }
        Copy-Item -Path "$pwaDist\*" -Destination $destDir -Recurse -Force
    } else {
        Push-Location (Join-Path $script:PROJECT_DIR "pwa")
        & pnpm install --frozen-lockfile
        & pnpm build
        Pop-Location
    }

    # Step 2: Setup API (only for native mode on Windows)
    Write-Step "2/4" "Setting up tmux-api..."
    if ($Mode -eq "native" -and -not $releaseMode) {
        Push-Location (Join-Path $script:PROJECT_DIR "tmux-api")
        $env:CGO_ENABLED = "0"
        & go build -ldflags="-s -w" -o tmux-api.exe .
        Pop-Location
    }

    # Step 3: Setup auth
    Write-Step "3/4" "Setting up auth..."
    Setup-Auth -NoAuth:$NoAuth

    # Step 4: Start services
    Write-Step "4/4" "Starting services..."

    switch ($Mode) {
        "container" {
            Start-ContainerMode -BindAddr $bindAddr -Port $Port
        }
        "native" {
            Start-NativeMode -BindAddr $bindAddr -Port $Port -NoAuth:$NoAuth
        }
    }

    # Setup Tailscale if requested
    if ($Tailscale) {
        Write-Info "Setting up Tailscale serve..."
        $tsPort = if ($Tailscale -match ":") { ($Tailscale -split ":")[-1] } else { "443" }
        & tailscale serve --bg --https=$tsPort http://127.0.0.1:$Port
    }

    Show-AccessInfo -Port $Port -Lan:$Lan -LanIP $lanIP -Tailscale $Tailscale -NoAuth:$NoAuth
}

function Invoke-Uninstall {
    param(
        [Parameter(Mandatory)]
        [ValidateSet("container", "native", "all")]
        [string]$Mode
    )

    Write-Host ""
    Write-Host "=== Termote Uninstall ($Mode) ===" -ForegroundColor White
    Write-Host ""

    if ($Mode -eq "container" -or $Mode -eq "all") {
        Write-Info "Stopping containers..."
        Stop-ContainerMode
    }

    if ($Mode -eq "native" -or $Mode -eq "all") {
        Write-Info "Stopping native services..."
        Stop-NativeMode
    }

    # Reset Tailscale serve
    if (Get-Command tailscale -ErrorAction SilentlyContinue) {
        Write-Info "Resetting Tailscale serve..."
        try { & tailscale serve reset 2>$null } catch {}
    }

    # Full cleanup
    if ($Mode -eq "all") {
        $nativeBin = Join-Path $script:PROJECT_DIR "tmux-api\tmux-api-native.exe"
        Remove-Item $nativeBin -ErrorAction SilentlyContinue
    }

    Write-Host ""
    Write-Info "Uninstall complete!"
}

function Invoke-Health {
    Write-Host ""
    Write-Host "=== Termote Health Check ===" -ForegroundColor White
    Write-Host ""

    $failed = 0
    $port = if ($Port -gt 0) { $Port } else { $script:PORT_MAIN }

    # Check container mode
    $containerMode = $false
    $runtime = $null
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        $container = & docker ps -q --filter "name=$script:CONTAINER_NAME" 2>$null
        if ($container) { $containerMode = $true; $runtime = "docker" }
    }
    if (-not $containerMode -and (Get-Command podman -ErrorAction SilentlyContinue)) {
        $container = & podman ps -q --filter "name=$script:CONTAINER_NAME" 2>$null
        if ($container) { $containerMode = $true; $runtime = "podman" }
    }

    # Check ttyd
    if ($containerMode) {
        try {
            $response = & $runtime exec $script:CONTAINER_NAME curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$script:PORT_TTYD/" 2>$null
            if ($response -eq "200") {
                Write-Host "  [OK] ttyd :$script:PORT_TTYD - running (container)" -ForegroundColor Green
            } else {
                Write-Host "  [--] ttyd :$script:PORT_TTYD - not running (container)" -ForegroundColor Red
                $failed++
            }
        } catch {
            Write-Host "  [--] ttyd :$script:PORT_TTYD - not running (container)" -ForegroundColor Red
            $failed++
        }
    } else {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$script:PORT_TTYD/" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            Write-Host "  [OK] ttyd :$script:PORT_TTYD - running" -ForegroundColor Green
        } catch {
            Write-Host "  [--] ttyd :$script:PORT_TTYD - not running" -ForegroundColor Red
            $failed++
        }
    }

    # Check main server
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:$port/" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        Write-Host "  [OK] tmux-api :$port - running" -ForegroundColor Green
    } catch {
        if ($_.Exception.Response.StatusCode -eq 401) {
            Write-Host "  [OK] tmux-api :$port - running (auth)" -ForegroundColor Green
        } else {
            Write-Host "  [--] tmux-api :$port - not running" -ForegroundColor Red
            $failed++
        }
    }

    # Check API endpoint
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/tmux/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        Write-Host "  [OK] API /api/tmux/health - running" -ForegroundColor Green
    } catch {
        if ($_.Exception.Response.StatusCode -eq 401) {
            Write-Host "  [OK] API /api/tmux/health - running (auth)" -ForegroundColor Green
        } else {
            Write-Host "  [--] API /api/tmux/health - not running" -ForegroundColor Yellow
        }
    }

    Write-Host ""
    if ($failed -eq 0) {
        Write-Host "All services healthy!" -ForegroundColor Green
    } else {
        Write-Host "$failed service(s) not running" -ForegroundColor Yellow
        exit 1
    }
}

function Invoke-Logs {
    param(
        [string]$Service = "all",
        [int]$Lines = 50
    )

    if (-not (Test-Path $script:LOG_DIR)) {
        Write-Warn "No logs found (log dir: $script:LOG_DIR)"
        return
    }

    switch ($Service) {
        "ttyd" {
            $logFile = Join-Path $script:LOG_DIR "ttyd.log"
            if (Test-Path $logFile) {
                Get-Content $logFile -Tail $Lines
            } else {
                Write-Warn "No ttyd logs"
            }
        }
        "tmux-api" {
            $logFile = Join-Path $script:LOG_DIR "tmux-api.log"
            if (Test-Path $logFile) {
                Get-Content $logFile -Tail $Lines
            } else {
                Write-Warn "No tmux-api logs"
            }
        }
        "api" { Invoke-Logs -Service "tmux-api" -Lines $Lines }
        "clean" {
            $sizeBefore = (Get-ChildItem $script:LOG_DIR -File | Measure-Object -Property Length -Sum).Sum / 1KB
            Remove-Item "$script:LOG_DIR\*.log" -ErrorAction SilentlyContinue
            Write-Info "Logs cleaned (was: $([math]::Round($sizeBefore, 2)) KB)"
        }
        default {
            Write-Host "=== ttyd logs ===" -ForegroundColor White
            $logFile = Join-Path $script:LOG_DIR "ttyd.log"
            if (Test-Path $logFile) { Get-Content $logFile -Tail $Lines } else { Write-Host "(empty)" }
            Write-Host ""
            Write-Host "=== tmux-api logs ===" -ForegroundColor White
            $logFile = Join-Path $script:LOG_DIR "tmux-api.log"
            if (Test-Path $logFile) { Get-Content $logFile -Tail $Lines } else { Write-Host "(empty)" }
        }
    }
}

# =============================================================================
# LINK/UNLINK - Global command setup
# =============================================================================

function Invoke-Link {
    $localBin = Join-Path $script:HOME_DIR ".local\bin"
    $cmdFile = Join-Path $localBin "termote.cmd"
    $ps1File = Join-Path $localBin "termote.ps1"
    $source = Join-Path $script:SCRIPT_DIR "termote.ps1"

    # Detect context: git repo (dev) or installed (~/.termote)
    $context = "installed"
    if (Test-Path (Join-Path $script:PROJECT_DIR ".git")) {
        $context = "development"
    }

    # Create ~/.local/bin if not exists
    if (-not (Test-Path $localBin)) {
        New-Item -ItemType Directory -Path $localBin -Force | Out-Null
        Write-Info "Created directory: $localBin"
    }

    # Check if already linked
    if (Test-Path $cmdFile) {
        $content = Get-Content $cmdFile -Raw
        if ($content -match [regex]::Escape($source)) {
            Write-Info "Already linked: $cmdFile -> $source"
            return
        } else {
            Write-Warn "Updating existing link"
        }
    }

    # Create .cmd wrapper (works from cmd.exe and PowerShell)
    $cmdContent = @"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$source" %*
"@
    Set-Content -Path $cmdFile -Value $cmdContent -Encoding ASCII
    Write-Info "Created: $cmdFile"

    # Also copy .ps1 for direct PowerShell usage
    Copy-Item -Path $source -Destination $ps1File -Force
    Write-Info "Created: $ps1File"

    if ($context -eq "development") {
        Write-Info "Linked to git repo (development mode)"
    }

    # Check if ~/.local/bin is in PATH
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$localBin*") {
        Write-Warn "$localBin is not in PATH"
        Write-Host ""
        Write-Host "Add to PATH permanently (requires restart):" -ForegroundColor White
        Write-Host "  [Environment]::SetEnvironmentVariable('Path', `$env:Path + ';$localBin', 'User')" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "Or add temporarily for this session:" -ForegroundColor White
        Write-Host "  `$env:Path += ';$localBin'" -ForegroundColor Cyan

        # Offer to add to PATH automatically
        $response = Read-Host "Add to PATH now? [Y/n]"
        if ($response -eq "" -or $response -match "^[Yy]") {
            $newPath = "$userPath;$localBin"
            [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
            $env:Path += ";$localBin"
            Write-Info "Added to PATH. Restart terminal for full effect."
        }
    } else {
        Write-Info "You can now run 'termote' from anywhere"
    }
}

function Invoke-Unlink {
    $removed = $false
    $localBin = Join-Path $script:HOME_DIR ".local\bin"
    $targets = @(
        (Join-Path $localBin "termote.cmd"),
        (Join-Path $localBin "termote.ps1")
    )

    foreach ($target in $targets) {
        if (Test-Path $target) {
            Remove-Item $target -Force
            Write-Info "Removed: $target"
            $removed = $true
        }
    }

    if (-not $removed) {
        Write-Info "No link found"
    } else {
        Write-Info "To restore: .\scripts\termote.ps1 link"
    }
}

function Show-Help {
    Show-Header
    Write-Host "Usage: termote.ps1 [command] [options]"
    Write-Host ""
    Write-Host "Commands:"
    Write-Host "  install <mode>    Install and start services"
    Write-Host "  uninstall <mode>  Remove installation"
    Write-Host "  health            Check service health"
    Write-Host "  logs [service]    View logs (ttyd, tmux-api, all, clean)"
    Write-Host "  link              Create 'termote' global command"
    Write-Host "  unlink            Remove global command"
    Write-Host "  help              Show this help"
    Write-Host ""
    Write-Host "Modes:"
    Write-Host "  container         Container mode (Docker/Podman Desktop)"
    Write-Host "  native            Native mode (psmux + ttyd)"
    Write-Host "  all               For uninstall: remove everything"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  -Port <port>      Host port (default: $script:PORT_MAIN)"
    Write-Host "  -Lan              Expose to LAN"
    Write-Host "  -Tailscale <h>    Enable Tailscale HTTPS"
    Write-Host "  -NoAuth           Disable authentication"
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  .\termote.ps1                           # Interactive menu"
    Write-Host "  .\termote.ps1 install container         # Container mode"
    Write-Host "  .\termote.ps1 install native -Lan       # Native + LAN"
    Write-Host "  .\termote.ps1 install native -NoAuth    # Without auth"
    Write-Host "  .\termote.ps1 uninstall all             # Full cleanup"
}

# =============================================================================
# MAIN
# =============================================================================

# No args = interactive mode
if (-not $Command) {
    Show-InteractiveMenu
    exit 0
}

# Parse command
switch ($Command) {
    "install" {
        if (-not $Mode) {
            Write-Err "Usage: termote.ps1 install <container|native> [options]"
        }
        Invoke-Install -Mode $Mode -Lan:$Lan -NoAuth:$NoAuth -Port $Port -Tailscale $Tailscale
    }
    "uninstall" {
        if (-not $Mode) {
            Write-Err "Usage: termote.ps1 uninstall <container|native|all>"
        }
        Invoke-Uninstall -Mode $Mode
    }
    "health" {
        Invoke-Health
    }
    "logs" {
        Invoke-Logs -Service $Mode
    }
    "link" {
        Invoke-Link
    }
    "unlink" {
        Invoke-Unlink
    }
    "help" {
        Show-Help
    }
    default {
        Write-Err "Unknown command: $Command"
    }
}
