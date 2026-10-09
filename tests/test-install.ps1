<#
.SYNOPSIS
    Tests for scripts/install.ps1
.DESCRIPTION
    Runs the installer in this session with Invoke-RestMethod and
    Invoke-WebRequest replaced by functions that serve a local release, and
    LOCALAPPDATA pointed at a temp dir. A small Go program stands in for
    termote.exe and logs its arguments.
    Run from repo root: ./tests/test-install.ps1
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

$TestDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$InstallPath = [System.IO.Path]::GetFullPath((Join-Path $TestDir "../scripts/install.ps1"))

$errors = $null
$null = [System.Management.Automation.PSParser]::Tokenize((Get-Content $InstallPath -Raw), [ref]$errors)
Write-TestResult "Syntax valid: install.ps1" ($errors.Count -eq 0) ($errors | Select-Object -First 1)
$code = (Get-Content $InstallPath) | Where-Object { $_ -notmatch '^\s*#' }
Write-TestResult "No RunAs / elevation" (-not ($code -match 'RunAs|Set-ExecutionPolicy'))
Write-TestResult "Does not use releases/latest" (-not ($code -match 'releases/latest'))

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    Write-Host "[SKIP] go not installed; installer behaviour tests" -ForegroundColor Yellow
    exit ([int]($script:TestsFailed -gt 0))
}

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("termote-install-test-" + [guid]::NewGuid().ToString("N"))
$Releases = Join-Path $Tmp "releases"
$BinLog = Join-Path $Tmp "bin.log"
$EchoSrc = @'
package main

import (
	"os"
	"strings"
)

func main() {
	f, _ := os.OpenFile(os.Getenv("BIN_LOG"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	f.WriteString(strings.Join(os.Args[1:], " ") + "\n")
	f.Close()
}
'@
$global:TermoteFakeTags = @()
$global:TermoteDownloads = @()

# Replace the web cmdlets for the installer run in this session. Their data is
# global: called from install.ps1, `script:` would name the installer's scope.
$global:TermoteReleases = $Releases
function global:Invoke-RestMethod {
    param([hashtable]$Headers, [string]$Uri)
    # A tag ending in :draft or :pre is listed as a draft or a pre-release.
    return $global:TermoteFakeTags | ForEach-Object {
        $tag, $kind = $_ -split ':', 2
        [pscustomobject]@{ tag_name = $tag; name = $tag; draft = ($kind -eq 'draft'); prerelease = ($kind -eq 'pre') }
    }
}
function global:Invoke-WebRequest {
    param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
    $global:TermoteDownloads += $Uri
    $rel = $Uri -replace '^.*/releases/download/', ''
    $src = Join-Path $global:TermoteReleases $rel
    if (-not (Test-Path $src)) { throw "404 $Uri" }
    Copy-Item $src $OutFile
}

function New-Release([string]$Version, [string]$Sum = 'good') {
    $name = "termote-$Version-windows-amd64"
    $stage = Join-Path $Tmp "stage\$name"
    New-Item -ItemType Directory -Path (Join-Path $stage 'bin') -Force | Out-Null
    $src = Join-Path $Tmp 'echo'
    New-Item -ItemType Directory -Path $src -Force | Out-Null
    Set-Content (Join-Path $src 'go.mod') "module echo`n`ngo 1.24`n"
    Set-Content (Join-Path $src 'main.go') $EchoSrc
    Push-Location $src
    try { & go build -o (Join-Path $stage 'bin\termote.exe') . } finally { Pop-Location }
    Set-Content (Join-Path $stage 'LICENSE') 'MIT'
    $dir = Join-Path $Releases "v$Version"
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Compress-Archive -Path $stage -DestinationPath (Join-Path $dir "$name.zip") -Force
    $hash = (Get-FileHash -Algorithm SHA256 (Join-Path $dir "$name.zip")).Hash.ToLower()
    if ($Sum -eq 'bad') { $hash = '0' * 64 }
    if ($Sum -ne 'none') { Set-Content (Join-Path $dir "$name.zip.sha256") "$hash  $name.zip" }
}

# The version current.txt names, or '' (a failed install must not abort the test).
function Get-Current {
    $f = Join-Path $Dir 'current.txt'
    if (Test-Path $f) { return (Get-Content $f -Raw).Trim() }
    return ''
}

# Runs the installer with a fresh LOCALAPPDATA; returns whether it succeeded.
function Invoke-Installer([string]$Pin = '') {
    $env:TERMOTE_VERSION = $Pin
    $global:TermoteDownloads = @()
    # A transcript keeps what the installer printed even when it throws.
    $log = Join-Path $Tmp ("run-" + [guid]::NewGuid().ToString("N") + ".log")
    $ok = $true
    Start-Transcript -Path $log | Out-Null
    try { & $InstallPath | Out-Host }
    catch { $ok = $false; Write-Host "threw: $_ ($($_.InvocationInfo.PositionMessage))" }
    finally {
        Stop-Transcript | Out-Null
        Remove-Item Env:TERMOTE_VERSION -ErrorAction SilentlyContinue
    }
    $script:Out = Get-Content $log -Raw
    return $ok
}

$savedLocal = $env:LOCALAPPDATA
$env:BIN_LOG = $BinLog
try {
    New-Item -ItemType Directory -Path $Tmp -Force | Out-Null
    $env:LOCALAPPDATA = Join-Path $Tmp 'local'
    $Dir = Join-Path $env:LOCALAPPDATA 'termote'
    New-Release '1.0.1'
    New-Release '1.0.10'

    $global:TermoteFakeTags = @('v1.0.11:draft', 'v1.0.12:pre', 'v0.1.0', 'v1.0.1', 'v1.0.10', 'v1.1.0-rc.1', 'latest')
    $ok = Invoke-Installer
    Write-TestResult "Fresh install succeeds" $ok $script:Out
    Write-TestResult "current.txt names the newest stable 1.x" ((Get-Current) -eq '1.0.10')
    Write-TestResult "Archive laid down as versions\<v>" (Test-Path (Join-Path $Dir 'versions\1.0.10\bin\termote.exe'))
    Write-TestResult "Runs termote link" ((Get-Content $BinLog -Raw) -match 'link')
    Write-TestResult "Prints the next step" ($script:Out -match 'termote start')

    $ok = Invoke-Installer
    Write-TestResult "Existing install left alone" ($ok -and $script:Out -match 'termote update' -and $global:TermoteDownloads.Count -eq 0) $script:Out

    $ok = Invoke-Installer '1.0.1'
    Write-TestResult "Pin rescues an install" ($ok -and (Get-Current) -eq '1.0.1')

    $env:LOCALAPPDATA = Join-Path $Tmp 'local2'
    $Dir = Join-Path $env:LOCALAPPDATA 'termote'
    Write-TestResult "Malformed TERMOTE_VERSION refused" (-not (Invoke-Installer '1.0'))
    New-Release '2.0.0' 'bad'
    Write-TestResult "Bad checksum refused" ((-not (Invoke-Installer '2.0.0')))
    New-Release '2.0.1' 'none'
    Write-TestResult "Missing checksum refused" ((-not (Invoke-Installer '2.0.1')))
    Write-TestResult "Nothing written after refusals" (-not (Test-Path (Join-Path $Dir 'versions')))

    # What uninstall leaves (logs, the trash, uploads not yet removed): installs.
    foreach ($d in 'state', 'trash', 'uploads', 'versions\0.9.0') {
        New-Item -ItemType Directory -Path (Join-Path $Dir $d) -Force | Out-Null
    }
    $ok = Invoke-Installer '1.0.1'
    Write-TestResult "Installs over what uninstall left" ($ok -and (Get-Current) -eq '1.0.1') $script:Out
    Remove-Item $Dir -Recurse -Force
    New-Item -ItemType Directory -Path $Dir -Force | Out-Null
    Set-Content (Join-Path $Dir 'other') 'x'
    Write-TestResult "Foreign dir refused" ((-not (Invoke-Installer '1.0.1')) -and $script:Out -match 'not a Termote install')
} finally {
    $env:LOCALAPPDATA = $savedLocal
    Remove-Item Env:BIN_LOG -ErrorAction SilentlyContinue
    Remove-Item function:global:Invoke-RestMethod, function:global:Invoke-WebRequest -ErrorAction SilentlyContinue
    Remove-Variable -Scope Global -Name TermoteFakeTags, TermoteDownloads, TermoteReleases -ErrorAction SilentlyContinue
    Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "=== Results ===" -ForegroundColor Cyan
Write-Host "Passed: $script:TestsPassed" -ForegroundColor Green
Write-Host "Failed: $script:TestsFailed" -ForegroundColor $(if ($script:TestsFailed -gt 0) { "Red" } else { "Green" })
# Explicit: the CI shell exits with $LASTEXITCODE of the last native command
# otherwise, and one test runs a binary that is meant to fail.
if ($script:TestsFailed -gt 0) { exit 1 }
exit 0
