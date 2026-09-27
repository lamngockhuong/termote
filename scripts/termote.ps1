<#
.SYNOPSIS
    Termote CLI shim for a git checkout on Windows.
.DESCRIPTION
    Builds server\termote-dev.exe (with the PWA embedded) when its sources
    changed, then runs it with the same arguments. Installed releases run
    termote.exe directly.
.EXAMPLE
    .\scripts\termote.ps1                     # Interactive menu
    .\scripts\termote.ps1 install native --lan
    .\scripts\termote.ps1 help                # All commands and options
#>

$ProjectDir = Split-Path -Parent $PSScriptRoot
$env:TERMOTE_PROJECT_DIR = $ProjectDir

function Stop-WithError([string]$Message) {
    Write-Host "[ERROR] $Message" -ForegroundColor Red
    exit 1
}

$api = Join-Path $ProjectDir 'server'
$pwa = Join-Path $ProjectDir 'pwa'
$pwaIndex = Join-Path $pwa 'dist\index.html'
$bin = Join-Path $api 'termote-dev.exe'
if (-not (Test-Path (Join-Path $api 'go.mod'))) {
    Stop-WithError "not a Termote checkout ($api\go.mod missing); installed releases run 'termote' directly"
}

# Build the PWA once; later changes are rebuilt with: pnpm --filter termote build
if ((Test-Path (Join-Path $pwa 'package.json')) -and -not (Test-Path $pwaIndex)) {
    if (Get-Command pnpm -ErrorAction SilentlyContinue) {
        Write-Host "[INFO] Building the PWA..." -ForegroundColor Green
        Push-Location $ProjectDir
        try {
            & pnpm install --frozen-lockfile --filter termote...
            if ($LASTEXITCODE -eq 0) { & pnpm --filter termote build }
        } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { Stop-WithError "PWA build failed" }
    } else {
        Write-Host "[WARN] pnpm not found; the server will show a placeholder page instead of the app" -ForegroundColor Yellow
    }
}

# Rebuild when a Go source or the PWA build is newer than the binary.
$newest = Get-ChildItem $api, (Join-Path $api 'webui') -File |
    Where-Object { $_.Extension -eq '.go' -or $_.Name -in @('go.mod', 'go.sum') } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
$stale = -not (Test-Path $bin)
if (-not $stale) {
    $built = (Get-Item $bin).LastWriteTime
    $stale = ($newest.LastWriteTime -gt $built) -or ((Test-Path $pwaIndex) -and (Get-Item $pwaIndex).LastWriteTime -gt $built)
}
if ($stale) {
    if (Get-Command go -ErrorAction SilentlyContinue) {
        Write-Host "[INFO] Building termote..." -ForegroundColor Green
        if (Test-Path $pwaIndex) {
            $embed = Join-Path $api 'webui\dist'
            New-Item -ItemType Directory -Path $embed -Force | Out-Null
            Get-ChildItem $embed -Force | Where-Object { $_.Name -ne '.gitkeep' } | Remove-Item -Recurse -Force
            Copy-Item (Join-Path $pwa 'dist\*') $embed -Recurse -Force
        }
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

# No command opens the interactive menu.
$goArgs = if ($args.Count -gt 0) { $args } else { @('menu') }
# A blocked binary (Defender, AppLocker) raises no exit code; never report success.
$global:LASTEXITCODE = $null
try { & $bin @goArgs } catch { Stop-WithError "Cannot run ${bin}: $_" }
if ($null -eq $LASTEXITCODE) { Stop-WithError "Cannot run $bin" }
exit $LASTEXITCODE
