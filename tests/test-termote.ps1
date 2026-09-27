<#
.SYNOPSIS
    Tests for the scripts/termote.ps1 shim
.DESCRIPTION
    Checks the 0.x parameter to Go flag mapping, binary selection (installed
    release and checkout build) and the command line 0.x `update` relaunches.
    A small Go program stands in for tmux-api and prints its arguments; the
    commands themselves are tested in Go (tmux-api/cli*_test.go).
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
$GetPath = [System.IO.Path]::GetFullPath((Join-Path $TestDir "../scripts/get.ps1"))

# ─────────────────────────────────────────────────────────────
# Syntax and size
# ─────────────────────────────────────────────────────────────
foreach ($file in @($ShimPath, $GetPath)) {
    $errors = $null
    $null = [System.Management.Automation.PSParser]::Tokenize((Get-Content $file -Raw), [ref]$errors)
    Write-TestResult "Syntax valid: $(Split-Path -Leaf $file)" ($errors.Count -eq 0) ($errors | Select-Object -First 1)
}
$lines = (Get-Content $ShimPath).Count
Write-TestResult "termote.ps1 is $lines lines (<= 100)" ($lines -le 100)
$shimText = Get-Content $ShimPath -Raw
Write-TestResult "No install logic in shim" (-not ($shimText -match 'docker|podman|tailscale serve|DPAPI|Start-Process'))

# ─────────────────────────────────────────────────────────────
# Fake tmux-api: prints DIR=<TERMOTE_PROJECT_DIR>, then one argument per line
# ─────────────────────────────────────────────────────────────
if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    Write-Host "[SKIP] go not installed; shim behaviour tests" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Passed: $script:TestsPassed, Failed: $script:TestsFailed"
    exit ([int]($script:TestsFailed -gt 0))
}

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("termote-test-" + [guid]::NewGuid().ToString("N"))
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

function New-EchoModule([string]$Dir) {
    New-Item -ItemType Directory -Path $Dir -Force | Out-Null
    Set-Content -Path (Join-Path $Dir "go.mod") -Value "module echoargs`n`ngo 1.24`n"
    Set-Content -Path (Join-Path $Dir "main.go") -Value $EchoSrc
}

# Launchers 0.x relaunches with: pwsh when present, else Windows PowerShell.
$Launchers = @((Get-Process -Id $PID).Path)
$winPS = Get-Command powershell.exe -ErrorAction SilentlyContinue
if ($winPS -and $winPS.Source -ne $Launchers[0]) { $Launchers += $winPS.Source }

# Runs the shim in a new process with -File, like 0.x update and termote.cmd.
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
    # Installed release layout
    # ─────────────────────────────────────────────────────────
    $install = Join-Path $Tmp "install"
    New-Item -ItemType Directory -Path (Join-Path $install "scripts") -Force | Out-Null
    Copy-Item $ShimPath (Join-Path $install "scripts/termote.ps1")
    $echoDir = Join-Path $Tmp "echo"
    New-EchoModule $echoDir
    Push-Location $echoDir
    try { & go build -o (Join-Path $install "tmux-api-windows-amd64.exe") . } finally { Pop-Location }
    Write-TestResult "Built fake tmux-api" ($LASTEXITCODE -eq 0)
    $shim = Join-Path $install "scripts/termote.ps1"

    foreach ($launcher in $Launchers) {
        $tag = Split-Path -Leaf $launcher
        Write-Host ""
        Write-Host "--- Installed release via $tag ---" -ForegroundColor Cyan

        $out = Invoke-Shim $launcher $shim @()
        Test-Equal "[$tag] no command opens the menu" "menu" (Get-PassedArgs $out)
        # Compare by content, not string: the temp path may be an 8.3 short name.
        $dir = ($out | Where-Object { $_.StartsWith("DIR=") } | Select-Object -First 1) -replace '^DIR=', ''
        Write-TestResult "[$tag] exports TERMOTE_PROJECT_DIR" ($dir -and (Test-Path (Join-Path $dir "tmux-api-windows-amd64.exe"))) "got: '$dir'"

        # The exact command line 0.1.0 `update` relaunches (termote.ps1:1288)
        $out = Invoke-Shim $launcher $shim @("install", "native", "-Lan", "-NoAuth", "-Port", "7700", "-Tailscale", "myhost:8443", "-Ttyd", "fork")
        Test-Equal "[$tag] 0.x update relaunch maps every flag" "install native --lan --no-auth --port 7700 --tailscale myhost:8443 --ttyd fork" (Get-PassedArgs $out)
        Test-Equal "[$tag] 0.x relaunch exits 0" "0" "$script:ShimExit"

        $out = Invoke-Shim $launcher $shim @("install", "native")
        Test-Equal "[$tag] unset -Port is not passed" "install native" (Get-PassedArgs $out)

        $out = Invoke-Shim $launcher $shim @("install", "native", "-Mux", "herdr", "-AllowHerdrNoAuth", "-NoAuth", "-Fresh", "-AllowHost", "box.local")
        Test-Equal "[$tag] 1.0 flags" "install native --no-auth --fresh --allow-herdr-no-auth --mux herdr --allow-host box.local" (Get-PassedArgs $out)

        $out = Invoke-Shim $launcher $shim @("update", "-Version", "1.0.0-rc.1", "-Force")
        Test-Equal "[$tag] update -Version -Force" "update --force --version 1.0.0-rc.1" (Get-PassedArgs $out)

        $out = Invoke-Shim $launcher $shim @("logs", "follow")
        Test-Equal "[$tag] positional service" "logs follow" (Get-PassedArgs $out)

        $env:ECHO_EXIT = "7"
        $null = Invoke-Shim $launcher $shim @("health")
        Remove-Item Env:ECHO_EXIT
        Test-Equal "[$tag] exit status passes through" "7" "$script:ShimExit"
    }

    # In-process call: -AllowHost takes a list
    $out = & $shim install native -AllowHost a.local, b.local | ForEach-Object { "$_" }
    Test-Equal "In-process -AllowHost list" "install native --allow-host a.local --allow-host b.local" (Get-PassedArgs @($out))

    # -Lan:$false is the only way to turn off a saved value
    $out = & $shim install native -Lan:$false -NoAuth | ForEach-Object { "$_" }
    Test-Equal "In-process -Lan:`$false" "install native --lan=false --no-auth" (Get-PassedArgs @($out))

    # A binary that cannot start (blocked, corrupt) must not look like success
    Set-Content -Path (Join-Path $install "tmux-api-windows-amd64.exe") -Value "not a program"
    $out = Invoke-Shim $Launchers[0] $shim @("health")
    Write-TestResult "Unrunnable binary fails" (($script:ShimExit -ne 0) -and (($out -join " ") -match "Cannot run")) "exit $script:ShimExit | $($out -join ' | ')"

    Remove-Item (Join-Path $install "tmux-api-windows-amd64.exe")
    $out = Invoke-Shim $Launchers[0] $shim @("health")
    Write-TestResult "Missing binary fails with a reinstall hint" (($script:ShimExit -ne 0) -and (($out -join " ") -match "reinstall Termote")) ($out -join " | ")

    # ─────────────────────────────────────────────────────────
    # Checkout layout: builds tmux-api\tmux-api-native.exe
    # ─────────────────────────────────────────────────────────
    Write-Host ""
    Write-Host "--- Checkout ---" -ForegroundColor Cyan
    $checkout = Join-Path $Tmp "checkout"
    New-Item -ItemType Directory -Path (Join-Path $checkout "scripts") -Force | Out-Null
    Copy-Item $ShimPath (Join-Path $checkout "scripts/termote.ps1")
    New-EchoModule (Join-Path $checkout "tmux-api")
    $cshim = Join-Path $checkout "scripts/termote.ps1"

    $out = Invoke-Shim $Launchers[0] $cshim @("install", "native", "-Lan")
    Test-Equal "Builds on first run and runs it" "install native --lan" (Get-PassedArgs $out)
    Write-TestResult "Binary is tmux-api\tmux-api-native.exe" (Test-Path (Join-Path $checkout "tmux-api/tmux-api-native.exe"))
    $out = Invoke-Shim $Launchers[0] $cshim @("version")
    Write-TestResult "Does not rebuild an up-to-date binary" (-not (($out -join " ") -match "Building"))
    (Get-Item (Join-Path $checkout "tmux-api/main.go")).LastWriteTime = (Get-Date).AddMinutes(1)
    $out = Invoke-Shim $Launchers[0] $cshim @("version")
    Write-TestResult "Rebuilds when a source is newer" (($out -join " ") -match "Building")
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
