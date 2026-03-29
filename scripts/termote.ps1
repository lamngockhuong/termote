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
    [int]$Port = 7690,
    [string]$Tailscale,
    [switch]$Fresh
)

# =============================================================================
# CONFIGURATION
# =============================================================================

$script:VERSION = "0.0.9" # x-release-please-version
$script:SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:PROJECT_DIR = Split-Path -Parent $script:SCRIPT_DIR

# Override VERSION when running from installed location (not git repo)
$versionFile = Join-Path $script:PROJECT_DIR ".version"
$isGitRepo = try { git -C $script:SCRIPT_DIR rev-parse --git-dir 2>$null; $LASTEXITCODE -eq 0 } catch { $false }
if (-not $isGitRepo -and (Test-Path $versionFile)) {
    $script:VERSION = (Get-Content $versionFile -Raw).Trim()
}
$script:PORT_MAIN = 7690
$script:PORT_CONTAINER = 7680
$script:PORT_TTYD = 7681
$script:CONTAINER_NAME = "termote"
$script:HOME_DIR = if ($env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME }
$script:LOG_DIR = Join-Path $script:HOME_DIR ".termote/logs"
$script:CONFIG_FILE = Join-Path $script:HOME_DIR ".termote/config.json"

# Saved config state (loaded once)
$script:SAVED_CONFIG = $null
$script:SAVED_PASS = $null
$script:REUSED_PASS = $false

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
# CONFIG PERSISTENCE (encrypted with DPAPI)
# =============================================================================

Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue

function Save-Config {
    param(
        [string]$Mode,
        [switch]$Lan,
        [switch]$NoAuth,
        [int]$Port,
        [string]$Tailscale,
        [string]$Password
    )

    $configDir = Split-Path $script:CONFIG_FILE -Parent
    if (-not (Test-Path $configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }

    # Encrypt password using DPAPI (Windows Data Protection API)
    $encryptedPass = ""
    if ($Password) {
        try {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($Password)
            $encrypted = [Security.Cryptography.ProtectedData]::Protect(
                $bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
            )
            $encryptedPass = [Convert]::ToBase64String($encrypted)
        } catch {
            Write-Warn "Could not encrypt password: $_"
        }
    }

    $config = @{
        Mode = $Mode
        Lan = $Lan.IsPresent -or $Lan
        NoAuth = $NoAuth.IsPresent -or $NoAuth
        Port = $Port
        Tailscale = $Tailscale
        EncryptedPass = $encryptedPass
        SavedAt = (Get-Date).ToString("o")
    }

    $config | ConvertTo-Json | Set-Content -Path $script:CONFIG_FILE -Encoding UTF8
    # Restrict permissions (Windows equivalent of chmod 600)
    $acl = Get-Acl $script:CONFIG_FILE
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        [Environment]::UserName, "FullControl", "Allow"
    )
    $acl.SetAccessRule($rule)
    Set-Acl -Path $script:CONFIG_FILE -AclObject $acl -ErrorAction SilentlyContinue
}

function Get-SavedConfig {
    if ($script:SAVED_CONFIG) { return $script:SAVED_CONFIG }

    if (-not (Test-Path $script:CONFIG_FILE)) { return $null }

    try {
        $config = Get-Content $script:CONFIG_FILE -Raw | ConvertFrom-Json

        # Decrypt password
        if ($config.EncryptedPass) {
            try {
                $encrypted = [Convert]::FromBase64String($config.EncryptedPass)
                $decrypted = [Security.Cryptography.ProtectedData]::Unprotect(
                    $encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
                )
                $script:SAVED_PASS = [System.Text.Encoding]::UTF8.GetString($decrypted)
            } catch {
                Write-Warn "Could not decrypt saved password"
                $script:SAVED_PASS = $null
            }
        }

        $script:SAVED_CONFIG = $config
        return $config
    } catch {
        Write-Warn "Could not load config: $_"
        return $null
    }
}

function Test-SavedTailscaleConfig {
    $config = Get-SavedConfig
    return $config -and $config.Tailscale
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

function Test-SensitiveDirs {
    param([string]$Workspace = ".\workspace")

    $sensitiveDirs = @(".ssh", ".gnupg", ".aws", ".config\gcloud")
    $found = @()

    foreach ($dir in $sensitiveDirs) {
        $path = Join-Path $Workspace $dir
        if (Test-Path $path) { $found += $dir }
    }

    if ($found.Count -gt 0) {
        Write-Warn "WORKSPACE contains sensitive directories: $($found -join ', ')"
        Write-Warn "These will be accessible inside the container. Consider using a subdirectory."
    }
}

function Setup-Auth {
    param(
        [switch]$NoAuth,
        [switch]$Fresh
    )

    if ($NoAuth) {
        Write-Info "Basic auth disabled"
        $env:TERMOTE_PASS = ""
        $env:NO_AUTH = "true"
        return
    }

    $env:NO_AUTH = ""

    # Reuse saved password unless -Fresh
    if (-not $Fresh -and $script:SAVED_PASS) {
        $env:TERMOTE_PASS = $script:SAVED_PASS
        $script:REUSED_PASS = $true
        Write-Info "Using saved password (use -Fresh to reset)"
        return
    }

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
        [int]$Port,
        [switch]$Lan
    )

    $runtime = Get-ContainerRuntime
    Write-Info "Using $runtime"

    # Validate inputs
    if (-not (Test-ValidPort $Port)) { Write-Err "Invalid port: $Port" }

    # Build or copy tmux-api for Linux (container is always Linux)
    $arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq [System.Runtime.InteropServices.Architecture]::Arm64) { "arm64" } else { "amd64" }
    $prebuilt = Join-Path $script:PROJECT_DIR "tmux-api-linux-$arch"
    $tmuxApiDir = Join-Path $script:PROJECT_DIR "tmux-api"
    if (Test-Path $prebuilt) {
        Write-Info "Using pre-built tmux-api for Linux/$arch"
        New-Item -ItemType Directory -Path $tmuxApiDir -Force | Out-Null
        Copy-Item -Path $prebuilt -Destination (Join-Path $tmuxApiDir "tmux-api") -Force
        if (-not (Test-Path (Join-Path $tmuxApiDir "tmux-api"))) { Write-Err "Failed to copy pre-built tmux-api" }
    } else {
        Write-Info "Cross-compiling tmux-api for Linux..."
        Push-Location $tmuxApiDir
        $env:CGO_ENABLED = "0"; $env:GOOS = "linux"; $env:GOARCH = $arch
        & go build -ldflags="-s -w" -o tmux-api .
        $buildExitCode = $LASTEXITCODE
        $env:CGO_ENABLED = $null; $env:GOOS = $null; $env:GOARCH = $null
        Pop-Location
        if ($buildExitCode -ne 0) { Write-Err "Cross-compilation failed" }
    }

    # Ensure workspace directory exists (Docker on Windows doesn't auto-create bind mounts)
    $workspace = Join-Path $script:PROJECT_DIR "workspace"
    New-Item -ItemType Directory -Path $workspace -Force | Out-Null

    # Stop existing
    Push-Location $script:PROJECT_DIR
    try {
        & $runtime compose down 2>$null
    } catch {}

    # Create override file (container always maps to localhost; LAN access via portproxy)
    $override = @"
services:
  termote:
    ports:
      - "127.0.0.1:${Port}:$($script:PORT_CONTAINER)"
"@
    $override | Out-File -FilePath "docker-compose.override.yml" -Encoding utf8 -NoNewline

    # Start container
    & $runtime compose --profile docker up -d --build
    if ($LASTEXITCODE -ne 0) {
        Remove-Item "docker-compose.override.yml" -ErrorAction SilentlyContinue
        Write-Err "Failed to start container"
    }

    Remove-Item "docker-compose.override.yml" -ErrorAction SilentlyContinue

    # On Windows, container port forwarding via WSL2/Hyper-V only listens on localhost.
    # Use netsh portproxy + firewall rule to expose the port to LAN (requires elevation).
    if ($Lan) {
        Write-Info "Setting up LAN port forwarding (netsh portproxy)..."
        $cmds = "netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=0.0.0.0 2>`$null; " +
                "netsh interface portproxy add v4tov4 listenport=$Port listenaddress=0.0.0.0 connectport=$Port connectaddress=127.0.0.1; " +
                "netsh advfirewall firewall delete rule name=`"Termote LAN`" 2>`$null; " +
                "netsh advfirewall firewall add rule name=`"Termote LAN`" dir=in action=allow protocol=tcp localport=$Port"
        try {
            Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -Command `"$cmds`"" -Wait -WindowStyle Hidden
            # Verify portproxy was actually created
            $verify = netsh interface portproxy show v4tov4 2>$null
            if ($verify -match "$Port") {
                Write-Info "LAN port forwarding enabled on port $Port"
            } else {
                Write-Warn "Port forwarding may not have been set up correctly"
            }
        } catch {
            Write-Warn "Failed to set up LAN port forwarding. Manually run as Administrator:"
            Write-Warn "  netsh interface portproxy add v4tov4 listenport=$Port listenaddress=0.0.0.0 connectport=$Port connectaddress=127.0.0.1"
            Write-Warn "  netsh advfirewall firewall add rule name=`"Termote LAN`" dir=in action=allow protocol=tcp localport=$Port"
        }
    }

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

    # Clean up LAN port forwarding if it exists
    $savedConfig = Get-SavedConfig
    if ($savedConfig -and $savedConfig.Lan -and $savedConfig.Mode -eq "container") {
        $port = if ($savedConfig.Port) { $savedConfig.Port } else { $script:PORT_MAIN }
        $verify = netsh interface portproxy show v4tov4 2>$null
        if ($verify -match "$port") {
            $cmd = "netsh interface portproxy delete v4tov4 listenport=$port listenaddress=0.0.0.0 2>`$null; " +
                   "netsh advfirewall firewall delete rule name=`"Termote LAN`" 2>`$null"
            try {
                Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -Command `"$cmd`"" -Wait -WindowStyle Hidden
            } catch {}
        }
    }
}

# =============================================================================
# NATIVE MODE (psmux + ttyd)
# =============================================================================

function Test-Psmux {
    $tmux = Get-Command tmux -ErrorAction SilentlyContinue
    if (-not $tmux) {
        Write-Err @"
psmux not found. Install it:
  winget install psmux

Or from: https://github.com/psmux/psmux
"@
    }

    # Verify it's psmux (not WSL tmux)
    if ($tmux.Source -notmatch "psmux") {
        Write-Warn "tmux found at $($tmux.Source) but may not be psmux. Proceeding anyway."
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
        [int]$Port = 7690,
        [string]$Tailscale,
        [switch]$Fresh
    )

    # Load saved config (unless -Fresh) and apply as defaults
    if (-not $Fresh) {
        $savedConfig = Get-SavedConfig
        if ($savedConfig) {
            # Apply saved values only if not explicitly provided
            if (-not $PSBoundParameters.ContainsKey('Lan') -and $savedConfig.Lan) { $Lan = $true }
            if (-not $PSBoundParameters.ContainsKey('NoAuth') -and $savedConfig.NoAuth) { $NoAuth = $true }
            if (-not $PSBoundParameters.ContainsKey('Port') -and $savedConfig.Port -and $savedConfig.Port -ne $script:PORT_MAIN) {
                $Port = $savedConfig.Port
            }
            if (-not $PSBoundParameters.ContainsKey('Tailscale') -and $savedConfig.Tailscale) {
                $Tailscale = $savedConfig.Tailscale
            }
        }
    }

    $bindAddr = if ($Lan) { "0.0.0.0" } else { "127.0.0.1" }
    $lanIP = if ($Lan) { Get-LanIP } else { "" }

    # Detect release mode (no pwa/package.json means this is an installed release, not the dev repo)
    $releaseMode = -not (Test-Path (Join-Path $script:PROJECT_DIR "pwa\package.json"))
    $pwaDistDir = Join-Path $script:PROJECT_DIR "pwa-dist"
    if ($releaseMode) {
        Write-Info "Release mode (using pre-built artifacts)"
    }

    Write-Host ""
    Write-Host "=== Termote Install ($Mode) ===" -ForegroundColor White
    Write-Host ""

    # Step 1: Setup PWA
    Write-Step "1/4" "Setting up PWA..."
    if ($releaseMode) {
        if (Test-Path $pwaDistDir) {
            $destDir = Join-Path $script:PROJECT_DIR "pwa\dist"
            if (-not (Test-Path $destDir)) {
                New-Item -ItemType Directory -Path $destDir -Force | Out-Null
            }
            Copy-Item -Path "$pwaDistDir\*" -Destination $destDir -Recurse -Force
            Remove-Item -Path $pwaDistDir -Recurse -Force
        } elseif (-not (Test-Path (Join-Path $script:PROJECT_DIR "pwa\dist"))) {
            Write-Err "PWA dist not found. Please reinstall from a release."
            return
        }
    } else {
        Push-Location (Join-Path $script:PROJECT_DIR "pwa")
        & pnpm install --frozen-lockfile
        & pnpm build
        Pop-Location
    }

    # Step 2: Setup API (only for native mode on Windows)
    Write-Step "2/4" "Setting up tmux-api..."
    if ($Mode -eq "native" -and $releaseMode) {
        # Copy pre-built binary to expected location
        $arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq [System.Runtime.InteropServices.Architecture]::Arm64) { "arm64" } else { "amd64" }
        $prebuilt = Join-Path $script:PROJECT_DIR "tmux-api-windows-$arch.exe"
        if (Test-Path $prebuilt) {
            $apiDir = Join-Path $script:PROJECT_DIR "tmux-api"
            if (-not (Test-Path $apiDir)) {
                New-Item -ItemType Directory -Path $apiDir -Force | Out-Null
            }
            Copy-Item -Path $prebuilt -Destination (Join-Path $apiDir "tmux-api.exe") -Force
        } else {
            Write-Err "Pre-built binary not found: tmux-api-windows-amd64.exe"
        }
    } elseif ($Mode -eq "native" -and -not $releaseMode) {
        Push-Location (Join-Path $script:PROJECT_DIR "tmux-api")
        $env:CGO_ENABLED = "0"
        & go build -ldflags="-s -w" -o tmux-api.exe .
        Pop-Location
    }

    # Step 3: Setup auth
    Write-Step "3/4" "Setting up auth..."
    Setup-Auth -NoAuth:$NoAuth -Fresh:$Fresh

    # Step 4: Start services
    Write-Step "4/4" "Starting services..."

    # Warn about sensitive directories (container mode only)
    if ($Mode -eq "container") {
        Test-SensitiveDirs
    }

    switch ($Mode) {
        "container" {
            Start-ContainerMode -Port $Port -Lan:$Lan
        }
        "native" {
            Start-NativeMode -BindAddr $bindAddr -Port $Port -NoAuth:$NoAuth
        }
    }

    # Setup Tailscale if requested
    if ($Tailscale) {
        if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
            Write-Warn "Tailscale not found in PATH. Skipping Tailscale setup."
            Write-Warn "Install Tailscale or add it to PATH: https://tailscale.com/download"
        } else {
            Write-Info "Setting up Tailscale serve..."
            $tsPort = if ($Tailscale -match ":") { ($Tailscale -split ":")[-1] } else { "443" }
            & tailscale serve --bg --https=$tsPort http://127.0.0.1:$Port
        }
    }

    # Save config for future restarts/updates
    Save-Config -Mode $Mode -Lan:$Lan -NoAuth:$NoAuth -Port $Port -Tailscale $Tailscale -Password $env:TERMOTE_PASS

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

function Test-ContainerEndpoint {
    param([string]$Runtime, [int]$Port, [string]$Path, [string]$Label)
    try {
        $response = & $Runtime exec $script:CONTAINER_NAME curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${Port}${Path}" 2>$null
        if ($response -eq "200") {
            Write-Host "  [OK] $Label - running (container)" -ForegroundColor Green; return $true
        } elseif ($response -eq "401") {
            Write-Host "  [OK] $Label - running (auth, container)" -ForegroundColor Green; return $true
        }
        Write-Host "  [--] $Label - not running (container, HTTP $response)" -ForegroundColor Red; return $false
    } catch {
        Write-Host "  [--] $Label - not running (container)" -ForegroundColor Red; return $false
    }
}

# Use raw TCP + HTTP/1.0 to avoid PS 5.1 auth negotiation hang with Invoke-WebRequest
function Test-NativeTcpEndpoint {
    param([int]$Port, [string]$Path, [string]$Label)
    $tcp = $null
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $tcp.Connect("127.0.0.1", $Port)
        $stream = $tcp.GetStream()
        $writer = New-Object System.IO.StreamWriter($stream)
        $reader = New-Object System.IO.StreamReader($stream)
        $writer.Write("GET $Path HTTP/1.0`r`nHost: localhost`r`n`r`n")
        $writer.Flush()
        $stream.ReadTimeout = 2000
        $statusLine = $reader.ReadLine()
        if ($statusLine -match "401") {
            Write-Host "  [OK] $Label - running (auth)" -ForegroundColor Green; return $true
        } elseif ($statusLine -match "200") {
            Write-Host "  [OK] $Label - running" -ForegroundColor Green; return $true
        }
        Write-Host "  [--] $Label - unexpected status: $statusLine" -ForegroundColor Red; return $false
    } catch {
        Write-Host "  [--] $Label - not running" -ForegroundColor Red; return $false
    } finally {
        if ($tcp) { $tcp.Close() }
    }
}

function Invoke-Health {
    Write-Host ""
    Write-Host "=== Termote Health Check ===" -ForegroundColor White
    Write-Host ""

    $failed = 0
    $port = if ($Port -gt 0) { $Port } else { $script:PORT_MAIN }

    # Detect container mode
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
        if (-not (Test-ContainerEndpoint -Runtime $runtime -Port $script:PORT_TTYD -Path "/" -Label "ttyd :$($script:PORT_TTYD)")) { $failed++ }
    } else {
        try {
            Invoke-WebRequest -Uri "http://127.0.0.1:$script:PORT_TTYD/" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop | Out-Null
            Write-Host "  [OK] ttyd :$($script:PORT_TTYD) - running" -ForegroundColor Green
        } catch {
            Write-Host "  [--] ttyd :$($script:PORT_TTYD) - not running" -ForegroundColor Red
            $failed++
        }
    }

    # Check tmux-api and API endpoint (container uses internal port 7680)
    $checkPort = if ($containerMode) { $script:PORT_CONTAINER } else { $port }
    $checks = @(
        @{ Path = "/"; Label = "tmux-api :$port" },
        @{ Path = "/api/tmux/health"; Label = "API /api/tmux/health" }
    )
    foreach ($check in $checks) {
        if ($containerMode) {
            if (-not (Test-ContainerEndpoint -Runtime $runtime -Port $checkPort -Path $check.Path -Label $check.Label)) { $failed++ }
        } else {
            if (-not (Test-NativeTcpEndpoint -Port $checkPort -Path $check.Path -Label $check.Label)) { $failed++ }
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
    Write-Host "  -Fresh            Ignore saved config, prompt for new password"
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  .\termote.ps1                           # Interactive menu"
    Write-Host "  .\termote.ps1 install container         # Container mode"
    Write-Host "  .\termote.ps1 install native -Lan       # Native + LAN"
    Write-Host "  .\termote.ps1 install native -NoAuth    # Without auth"
    Write-Host "  .\termote.ps1 install native -Fresh     # Reset password"
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
        Invoke-Install -Mode $Mode -Lan:$Lan -NoAuth:$NoAuth -Port $Port -Tailscale $Tailscale -Fresh:$Fresh
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
