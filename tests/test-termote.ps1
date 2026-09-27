<#
.SYNOPSIS
    Tests for the scripts/termote.ps1 checkout shim
.DESCRIPTION
    Checks the build on demand (Go sources and the PWA build), argument
    pass-through and exit status. A small Go program stands in for termote
    and prints its arguments; the commands themselves are tested in Go
    (server/cli*_test.go).
    Run from repo root: ./tests/test-termote.ps1
#>

$ErrorActionPreference = "Stop"
$script:TestsPassed = 0
$script:TestsFailed = 0

function Write-TestResult {
    param([string]$Name, [bool]$Passed, [string]$Detail = "")
    if ($Passed) {
        Write-Host "[PASS] $Name" -ForegroundColor Green
        $script:TestsPassed++
    } else {
        Write-Host "[FAIL] $Name" -ForegroundColor Red
        if ($Detail) { Write-Host "       $Detail" -ForegroundColor DarkRed }
        $script:TestsFailed++
    }
}

function Test-Equal([string]$Name, [string]$Expected, [string]$Actual) {
    Write-TestResult $Name ($Expected -ceq $Actual) "expected: '$Expected', got: '$Actual'"
}

Write-Host ""
Write-Host "=== Termote PowerShell Shim Tests ===" -ForegroundColor Cyan
Write-Host ""

$TestDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$ShimPath = [System.IO.Path]::GetFullPath((Join-Path $TestDir "../scripts/termote.ps1"))

# ─────────────────────────────────────────────────────────────
# Syntax and size
# ─────────────────────────────────────────────────────────────
$errors = $null
$null = [System.Management.Automation.PSParser]::Tokenize((Get-Content $ShimPath -Raw), [ref]$errors)
Write-TestResult "Syntax valid: termote.ps1" ($errors.Count -eq 0) ($errors | Select-Object -First 1)
$lines = (Get-Content $ShimPath).Count
Write-TestResult "termote.ps1 is $lines lines (<= 100)" ($lines -le 100)
$shimText = Get-Content $ShimPath -Raw
Write-TestResult "No install logic in shim" (-not ($shimText -match 'docker|podman|tailscale serve|DPAPI|Start-Process'))

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    Write-Host "[SKIP] go not installed; shim behaviour tests" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Passed: $script:TestsPassed, Failed: $script:TestsFailed"
    exit ([int]($script:TestsFailed -gt 0))
}

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("termote-test-" + [guid]::NewGuid().ToString("N"))
# Fake termote: prints DIR=<TERMOTE_PROJECT_DIR>, then one argument per line
$EchoSrc = @'
package main

import (
	"fmt"
	"os"
	"strconv"
)

func main() {
	fmt.Println("DIR=" + os.Getenv("TERMOTE_PROJECT_DIR"))
	for _, a := range os.Args[1:] {
		fmt.Println(a)
	}
	code, _ := strconv.Atoi(os.Getenv("ECHO_EXIT"))
	os.Exit(code)
}
'@

# Launchers: pwsh when present, else Windows PowerShell (termote.cmd uses it).
$Launchers = @((Get-Process -Id $PID).Path)
$winPS = Get-Command powershell.exe -ErrorAction SilentlyContinue
if ($winPS -and $winPS.Source -ne $Launchers[0]) { $Launchers += $winPS.Source }

# Runs the shim in a new process with -File, like termote.cmd.
function Invoke-Shim([string]$Launcher, [string]$Shim, [string[]]$ShimArgs) {
    $out = & $Launcher -NoProfile -ExecutionPolicy Bypass -File $Shim @ShimArgs 2>&1 | ForEach-Object { "$_" }
    $script:ShimExit = $LASTEXITCODE
    return , @($out)
}

# Arguments the fake binary received, joined by spaces.
function Get-PassedArgs($Out) {
    $i = [array]::FindIndex([string[]]$Out, [Predicate[string]] { param($l) $l.StartsWith("DIR=") })
    if ($i -lt 0) { return "<no DIR line: $($Out -join ' | ')>" }
    return ($Out | Select-Object -Skip ($i + 1)) -join " "
}

try {
    # ─────────────────────────────────────────────────────────
    # Outside a checkout
    # ─────────────────────────────────────────────────────────
    $copy = Join-Path $Tmp "copy"
    New-Item -ItemType Directory -Path (Join-Path $copy "scripts") -Force | Out-Null
    Copy-Item $ShimPath (Join-Path $copy "scripts/termote.ps1")
    $out = Invoke-Shim $Launchers[0] (Join-Path $copy "scripts/termote.ps1") @("version")
    Write-TestResult "Refuses to run outside a checkout" (($script:ShimExit -ne 0) -and (($out -join " ") -match "not a Termote checkout")) ($out -join " | ")

    # ─────────────────────────────────────────────────────────
    # Checkout layout: builds server\termote-dev.exe
    # ─────────────────────────────────────────────────────────
    $checkout = Join-Path $Tmp "checkout"
    $server = Join-Path $checkout "server"
    $embed = Join-Path $server "webui/dist"
    New-Item -ItemType Directory -Path (Join-Path $checkout "scripts"), $embed -Force | Out-Null
    Copy-Item $ShimPath (Join-Path $checkout "scripts/termote.ps1")
    Set-Content -Path (Join-Path $server "go.mod") -Value "module echoargs`n`ngo 1.24`n"
    Set-Content -Path (Join-Path $server "main.go") -Value $EchoSrc
    New-Item -ItemType File -Path (Join-Path $embed ".gitkeep") -Force | Out-Null
    $cshim = Join-Path $checkout "scripts/termote.ps1"

    $out = Invoke-Shim $Launchers[0] $cshim @("start", "--lan")
    Test-Equal "Builds on first run and runs it" "start --lan" (Get-PassedArgs $out)
    Write-TestResult "Binary is server\termote-dev.exe" (Test-Path (Join-Path $server "termote-dev.exe"))

    foreach ($launcher in $Launchers) {
        $tag = Split-Path -Leaf $launcher
        # The binary opens the menu itself; the shim passes no argument.
        $out = Invoke-Shim $launcher $cshim @()
        Test-Equal "[$tag] no command passes none" "" (Get-PassedArgs $out)
        # Compare by content, not string: the temp path may be an 8.3 short name.
        $dir = ($out | Where-Object { $_.StartsWith("DIR=") } | Select-Object -First 1) -replace '^DIR=', ''
        Write-TestResult "[$tag] exports TERMOTE_PROJECT_DIR" ($dir -and (Test-Path (Join-Path $dir "server/go.mod"))) "got: '$dir'"
        $out = Invoke-Shim $launcher $cshim @("start", "--mux", "herdr", "--allow-host", "box.local", "--lan=false")
        Test-Equal "[$tag] passes Go flags through" "start --mux herdr --allow-host box.local --lan=false" (Get-PassedArgs $out)
        $env:ECHO_EXIT = "7"
        $null = Invoke-Shim $launcher $cshim @("health")
        Remove-Item Env:ECHO_EXIT
        Test-Equal "[$tag] exit status passes through" "7" "$script:ShimExit"
    }

    $out = Invoke-Shim $Launchers[0] $cshim @("version")
    Write-TestResult "Does not rebuild an up-to-date binary" (-not (($out -join " ") -match "Building"))
    (Get-Item (Join-Path $server "main.go")).LastWriteTime = (Get-Date).AddMinutes(1)
    $out = Invoke-Shim $Launchers[0] $cshim @("version")
    Write-TestResult "Rebuilds when a source is newer" (($out -join " ") -match "Building")

    # A newer PWA build is copied into webui\dist; stale files go, .gitkeep stays.
    New-Item -ItemType File -Path (Join-Path $embed "old-asset.js") -Force | Out-Null
    $pwaBuild = Join-Path $checkout "pwa/dist"
    New-Item -ItemType Directory -Path (Join-Path $pwaBuild "assets") -Force | Out-Null
    Set-Content -Path (Join-Path $checkout "pwa/package.json") -Value "{}"
    Set-Content -Path (Join-Path $pwaBuild "assets/app.js") -Value "js"
    Set-Content -Path (Join-Path $pwaBuild "index.html") -Value "<html>app</html>"
    (Get-Item (Join-Path $pwaBuild "index.html")).LastWriteTime = (Get-Date).AddMinutes(2)
    $out = Invoke-Shim $Launchers[0] $cshim @("version")
    $synced = (Test-Path (Join-Path $embed "assets/app.js")) -and (Test-Path (Join-Path $embed ".gitkeep")) -and -not (Test-Path (Join-Path $embed "old-asset.js"))
    Write-TestResult "Rebuilds with a newer PWA build copied into webui\dist" ((($out -join " ") -match "Building") -and $synced) ($out -join " | ")

    # A binary that cannot start (blocked, corrupt) must not look like success
    Set-Content -Path (Join-Path $server "termote-dev.exe") -Value "not a program"
    (Get-Item (Join-Path $server "termote-dev.exe")).LastWriteTime = (Get-Date).AddMinutes(5)
    $out = Invoke-Shim $Launchers[0] $cshim @("health")
    Write-TestResult "Unrunnable binary fails" (($script:ShimExit -ne 0) -and (($out -join " ") -match "Cannot run")) "exit $script:ShimExit | $($out -join ' | ')"
} finally {
    Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# ─────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Results ===" -ForegroundColor Cyan
Write-Host "Passed: $script:TestsPassed" -ForegroundColor Green
Write-Host "Failed: $script:TestsFailed" -ForegroundColor $(if ($script:TestsFailed -gt 0) { "Red" } else { "Green" })
if ($script:TestsFailed -gt 0) { exit 1 }
