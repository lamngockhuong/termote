<#
.SYNOPSIS
    Termote CLI shim for Windows: every command lives in the termote binary.
.DESCRIPTION
    Keeps the 0.x parameters and maps them to the Go flags. 0.x `update`
    relaunches this exact path with `install <mode> -Lan -NoAuth -Port -Tailscale
    -Ttyd`, so the path and those parameters must keep working.
.EXAMPLE
    .\termote.ps1                           # Interactive menu
    .\termote.ps1 install native -Lan       # Native mode (psmux), LAN access
    .\termote.ps1 help                      # All commands and options
#>

[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Position = 0)]
    [string]$Command,
    # Install/uninstall mode or logs service; the Go CLI validates it.
    [Parameter(Position = 1)]
    [string]$Mode,
    [switch]$Lan,
    [switch]$NoAuth,
    [int]$Port,
    [string]$Tailscale,
    # Removed in 1.0.0; accepted so a 0.x update can relaunch this script.
    [string]$Ttyd,
    [switch]$Fresh,
    [string]$Mux,
    [string[]]$AllowHost,
    [switch]$AllowHerdrNoAuth,
    # -Version maps to $TargetVersion so it cannot clash with a version variable.
    [Alias('Version')]
    [string]$TargetVersion,
    [switch]$Force,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ProjectDir = Split-Path -Parent $PSScriptRoot
$env:TERMOTE_PROJECT_DIR = $ProjectDir

function Stop-WithError([string]$Message) {
    Write-Host "[ERROR] $Message" -ForegroundColor Red
    exit 1
}

# No command opens the interactive menu, as in 0.x.
$goArgs = @(if ($Command) { $Command } else { 'menu' })
if ($Mode) { $goArgs += $Mode }
if ($Rest) { $goArgs += $Rest }

$switches = [ordered]@{ Lan = '--lan'; NoAuth = '--no-auth'; Fresh = '--fresh'; AllowHerdrNoAuth = '--allow-herdr-no-auth'; Force = '--force' }
# -Lan:$false becomes --lan=false: the only way to turn off a saved value.
foreach ($name in $switches.Keys) {
    if ($PSBoundParameters.ContainsKey($name)) {
        $goArgs += if ($PSBoundParameters[$name]) { $switches[$name] } else { "$($switches[$name])=false" }
    }
}
# Pass values only when given: an unset -Port must not override the saved port.
# Empty strings are skipped too, since Windows PowerShell drops empty native arguments.
$values = [ordered]@{ Port = '--port'; Tailscale = '--tailscale'; Ttyd = '--ttyd'; Mux = '--mux'; TargetVersion = '--version' }
foreach ($name in $values.Keys) {
    if ($PSBoundParameters.ContainsKey($name) -and "$($PSBoundParameters[$name])" -ne '') {
        $goArgs += @($values[$name], "$($PSBoundParameters[$name])")
    }
}
foreach ($h in $AllowHost) { if ($h) { $goArgs += @('--allow-host', $h) } }

$api = Join-Path $ProjectDir 'server'
if (Test-Path (Join-Path $api 'go.mod')) {
    # Checkout: rebuild when any Go source is newer than the binary. The CLI
    # recognises a checkout server by this name, so keep termote-dev.exe.
    $bin = Join-Path $api 'termote-dev.exe'
    $newest = Get-ChildItem $api -File |
        Where-Object { $_.Extension -eq '.go' -or $_.Name -in @('go.mod', 'go.sum') } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not (Test-Path $bin) -or $newest.LastWriteTime -gt (Get-Item $bin).LastWriteTime) {
        if (Get-Command go -ErrorAction SilentlyContinue) {
            Write-Host "[INFO] Building termote..." -ForegroundColor Green
            Push-Location $api
            $env:CGO_ENABLED = '0'
            try { & go build -ldflags="-s -w" -o termote-dev.exe . } finally { Pop-Location }
            if ($LASTEXITCODE -ne 0) { Stop-WithError "Build failed" }
        } elseif (Test-Path $bin) {
            Write-Host "[WARN] Go not found; running the existing (older) termote build" -ForegroundColor Yellow
        } else {
            Stop-WithError "Go is required to build termote in a checkout: https://go.dev/dl/"
        }
    }
} else {
    # Installed release; Windows on ARM runs the amd64 build.
    $bin = Join-Path $ProjectDir 'termote-windows-amd64.exe'
    if (-not (Test-Path $bin)) { Stop-WithError "$bin not found; reinstall Termote" }
}

# A blocked binary (Defender, AppLocker) raises no exit code; never report success.
$global:LASTEXITCODE = $null
try { & $bin @goArgs } catch { Stop-WithError "Cannot run ${bin}: $_" }
if ($null -eq $LASTEXITCODE) { Stop-WithError "Cannot run $bin" }
exit $LASTEXITCODE
