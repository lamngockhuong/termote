<#
.SYNOPSIS
    Test suite for get.ps1 (Windows online installer)
.DESCRIPTION
    Validates PowerShell script syntax and basic functionality.
    Run from repo root: ./tests/test-get.ps1
#>

$ErrorActionPreference = "Stop"
$script:TestsPassed = 0
$script:TestsFailed = 0

function Write-TestResult {
    param(
        [string]$Name,
        [bool]$Passed,
        [string]$Error = ""
    )

    if ($Passed) {
        Write-Host "[PASS] $Name" -ForegroundColor Green
        $script:TestsPassed++
    } else {
        Write-Host "[FAIL] $Name" -ForegroundColor Red
        if ($Error) { Write-Host "       $Error" -ForegroundColor DarkRed }
        $script:TestsFailed++
    }
}

Write-Host ""
Write-Host "=== Termote get.ps1 Tests ===" -ForegroundColor Cyan
Write-Host ""

# Determine script path
$TestDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $TestDir) { $TestDir = Get-Location }
$ScriptPath = Join-Path $TestDir ".." "scripts" "get.ps1"
$ScriptPath = [System.IO.Path]::GetFullPath($ScriptPath)
if (-not (Test-Path $ScriptPath)) {
    Write-Host "[ERROR] Script not found: $ScriptPath" -ForegroundColor Red
    exit 1
}

# ─────────────────────────────────────────────────────────────
# Test 1: Script syntax is valid
# ─────────────────────────────────────────────────────────────
try {
    $errors = $null
    $null = [System.Management.Automation.PSParser]::Tokenize(
        (Get-Content $ScriptPath -Raw),
        [ref]$errors
    )
    Write-TestResult -Name "Script syntax valid" -Passed ($errors.Count -eq 0) -Error ($errors | Select-Object -First 1).Message
} catch {
    Write-TestResult -Name "Script syntax valid" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 2: Required parameters defined
# ─────────────────────────────────────────────────────────────
try {
    $content = Get-Content $ScriptPath -Raw
    $hasYes = $content -match '\[switch\]\$Yes'
    $hasDownloadOnly = $content -match '\[switch\]\$DownloadOnly'
    $hasUpdate = $content -match '\[switch\]\$Update'
    $hasMode = $content -match '\[string\]\$Mode'
    $hasLan = $content -match '\[switch\]\$Lan'
    $hasNoAuth = $content -match '\[switch\]\$NoAuth'
    $allExist = $hasYes -and $hasDownloadOnly -and $hasUpdate -and $hasMode -and $hasLan -and $hasNoAuth
    Write-TestResult -Name "Required parameters defined" -Passed $allExist
} catch {
    Write-TestResult -Name "Required parameters defined" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 3: Environment variable support
# ─────────────────────────────────────────────────────────────
try {
    $content = Get-Content $ScriptPath -Raw
    $hasAutoYes = $content -match 'TERMOTE_AUTO_YES'
    $hasDownloadOnlyEnv = $content -match 'TERMOTE_DOWNLOAD_ONLY'
    $hasUpdateEnv = $content -match 'TERMOTE_UPDATE'
    $hasModeEnv = $content -match 'TERMOTE_MODE'
    $allExist = $hasAutoYes -and $hasDownloadOnlyEnv -and $hasUpdateEnv -and $hasModeEnv
    Write-TestResult -Name "Environment variable support" -Passed $allExist
} catch {
    Write-TestResult -Name "Environment variable support" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 4: Core functions exist
# ─────────────────────────────────────────────────────────────
try {
    $content = Get-Content $ScriptPath -Raw
    $hasGetInstalledVersion = $content -match "function Get-InstalledVersion"
    $hasGetLatestVersion = $content -match "function Get-LatestVersion"
    $hasTestChecksum = $content -match "function Test-Checksum"
    $hasMain = $content -match "function Main"
    $allExist = $hasGetInstalledVersion -and $hasGetLatestVersion -and $hasTestChecksum -and $hasMain
    Write-TestResult -Name "Core functions exist" -Passed $allExist
} catch {
    Write-TestResult -Name "Core functions exist" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 5: GitHub API integration
# ─────────────────────────────────────────────────────────────
try {
    $content = Get-Content $ScriptPath -Raw
    $hasRepo = $content -match 'lamngockhuong/termote'
    $hasGitHubApi = $content -match 'api\.github\.com/repos'
    $hasReleasesDownload = $content -match 'github\.com.*releases/download'
    $allExist = $hasRepo -and $hasGitHubApi -and $hasReleasesDownload
    Write-TestResult -Name "GitHub API integration" -Passed $allExist
} catch {
    Write-TestResult -Name "GitHub API integration" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 6: Checksum verification
# ─────────────────────────────────────────────────────────────
try {
    $content = Get-Content $ScriptPath -Raw
    $hasChecksums = $content -match 'checksums\.txt'
    $hasSHA256 = $content -match 'SHA256'
    $hasVerify = $content -match 'Checksum verified'
    $allExist = $hasChecksums -and $hasSHA256 -and $hasVerify
    Write-TestResult -Name "Checksum verification" -Passed $allExist
} catch {
    Write-TestResult -Name "Checksum verification" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 7: Update mode support
# ─────────────────────────────────────────────────────────────
try {
    $content = Get-Content $ScriptPath -Raw
    $hasUpdateParam = $content -match '\[switch\]\$Update'
    $hasGetSavedConfig = $content -match "function Get-SavedConfig"
    $hasUpdateLogic = $content -match 'if \(\$Update\)'
    $allExist = $hasUpdateParam -and $hasGetSavedConfig -and $hasUpdateLogic
    Write-TestResult -Name "Update mode support" -Passed $allExist
} catch {
    Write-TestResult -Name "Update mode support" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 8: Service management
# ─────────────────────────────────────────────────────────────
try {
    $content = Get-Content $ScriptPath -Raw
    $hasTestServices = $content -match "function Test-ServicesRunning"
    $hasStopServices = $content -match "function Stop-Services"
    $allExist = $hasTestServices -and $hasStopServices
    Write-TestResult -Name "Service management" -Passed $allExist
} catch {
    Write-TestResult -Name "Service management" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "─────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host "Passed: $script:TestsPassed" -ForegroundColor Green
Write-Host "Failed: $script:TestsFailed" -ForegroundColor $(if ($script:TestsFailed -gt 0) { "Red" } else { "Green" })
Write-Host ""

if ($script:TestsFailed -gt 0) {
    Write-Host "Some tests failed!" -ForegroundColor Red
    exit 1
} else {
    Write-Host "All tests passed!" -ForegroundColor Green
    exit 0
}
