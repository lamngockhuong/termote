<#
.SYNOPSIS
    Test suite for termote.ps1
.DESCRIPTION
    Validates PowerShell script syntax and basic functionality.
    Run from repo root: ./tests/test-termote.ps1
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
Write-Host "=== Termote PowerShell Tests ===" -ForegroundColor Cyan
Write-Host ""

# Determine script path
$TestDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $TestDir) { $TestDir = Get-Location }
$ScriptPath = Join-Path (Join-Path (Join-Path $TestDir "..") "scripts") "termote.ps1"
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
# Test 2: Help command works (check script contains Show-Help function)
# ─────────────────────────────────────────────────────────────
try {
    $content = Get-Content $ScriptPath -Raw
    $hasShowHelp = $content -match "function Show-Help"
    $hasUsageText = $content -match 'Usage: termote\.ps1'
    Write-TestResult -Name "Help command works" -Passed ($hasShowHelp -and $hasUsageText)
} catch {
    Write-TestResult -Name "Help command works" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 3: Version is defined
# ─────────────────────────────────────────────────────────────
try {
    $content = Get-Content $ScriptPath -Raw
    $hasVersion = $content -match '\$script:VERSION\s*=\s*"[0-9]+\.[0-9]+\.[0-9]+"'
    Write-TestResult -Name "Version is defined" -Passed $hasVersion
} catch {
    Write-TestResult -Name "Version is defined" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 4: Container runtime detection function exists
# ─────────────────────────────────────────────────────────────
try {
    $content = Get-Content $ScriptPath -Raw
    $hasFunction = $content -match "function Get-ContainerRuntime"
    Write-TestResult -Name "Get-ContainerRuntime function exists" -Passed $hasFunction
} catch {
    Write-TestResult -Name "Get-ContainerRuntime function exists" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 5: Health function exists
# ─────────────────────────────────────────────────────────────
try {
    $content = Get-Content $ScriptPath -Raw
    $hasFunction = $content -match "function Invoke-Health"
    Write-TestResult -Name "Invoke-Health function exists" -Passed $hasFunction
} catch {
    Write-TestResult -Name "Invoke-Health function exists" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 6: Native mode functions exist
# ─────────────────────────────────────────────────────────────
try {
    $content = Get-Content $ScriptPath -Raw
    $hasPsmux = $content -match "function Test-Psmux"
    $hasTtyd = $content -match "function Get-TtydBinary"
    $hasNative = $content -match "function Start-NativeMode"
    $allExist = $hasPsmux -and $hasTtyd -and $hasNative
    Write-TestResult -Name "Native mode functions exist" -Passed $allExist
} catch {
    Write-TestResult -Name "Native mode functions exist" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 7: Required parameters are defined
# ─────────────────────────────────────────────────────────────
try {
    $content = Get-Content $ScriptPath -Raw
    $hasCommand = $content -match '\[string\]\$Command'
    $hasMode = $content -match '\[string\]\$Mode'
    $hasLan = $content -match '\[switch\]\$Lan'
    $hasNoAuth = $content -match '\[switch\]\$NoAuth'
    $hasPort = $content -match '\[int\]\$Port'
    $allExist = $hasCommand -and $hasMode -and $hasLan -and $hasNoAuth -and $hasPort
    Write-TestResult -Name "Required parameters defined" -Passed $allExist
} catch {
    Write-TestResult -Name "Required parameters defined" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 8: Link/Unlink functions exist
# ─────────────────────────────────────────────────────────────
try {
    $content = Get-Content $ScriptPath -Raw
    $hasLink = $content -match "function Invoke-Link"
    $hasUnlink = $content -match "function Invoke-Unlink"
    $hasLinkCmd = $content -match '"link"'
    $hasUnlinkCmd = $content -match '"unlink"'
    $allExist = $hasLink -and $hasUnlink -and $hasLinkCmd -and $hasUnlinkCmd
    Write-TestResult -Name "Link/Unlink functions exist" -Passed $allExist
} catch {
    Write-TestResult -Name "Link/Unlink functions exist" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 9: Config persistence functions exist
# ─────────────────────────────────────────────────────────────
try {
    $content = Get-Content $ScriptPath -Raw
    $hasSaveConfig = $content -match "function Save-Config"
    $hasGetConfig = $content -match "function Get-SavedConfig"
    $hasConfigFile = $content -match '\$script:CONFIG_FILE'
    $allExist = $hasSaveConfig -and $hasGetConfig -and $hasConfigFile
    Write-TestResult -Name "Config persistence functions exist" -Passed $allExist
} catch {
    Write-TestResult -Name "Config persistence functions exist" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 10: Fresh parameter defined
# ─────────────────────────────────────────────────────────────
try {
    $content = Get-Content $ScriptPath -Raw
    $hasFreshParam = $content -match '\[switch\]\$Fresh'
    $hasFreshUsage = $content -match '-Fresh'
    Write-TestResult -Name "Fresh parameter defined" -Passed ($hasFreshParam -and $hasFreshUsage)
} catch {
    Write-TestResult -Name "Fresh parameter defined" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 11: Windows default port avoids DoSvc conflict (7690)
# ─────────────────────────────────────────────────────────────
try {
    $content = Get-Content $ScriptPath -Raw
    $hasPortMain = $content -match '\$script:PORT_MAIN\s*=\s*7690'
    $hasPortContainer = $content -match '\$script:PORT_CONTAINER\s*=\s*7680'
    Write-TestResult -Name "Windows default port 7690 (avoids DoSvc)" -Passed ($hasPortMain -and $hasPortContainer)
} catch {
    Write-TestResult -Name "Windows default port 7690 (avoids DoSvc)" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 12: Health check helper functions exist
# ─────────────────────────────────────────────────────────────
try {
    $content = Get-Content $ScriptPath -Raw
    $hasContainerCheck = $content -match "function Test-ContainerEndpoint"
    $hasNativeCheck = $content -match "function Test-NativeTcpEndpoint"
    Write-TestResult -Name "Health check helpers exist" -Passed ($hasContainerCheck -and $hasNativeCheck)
} catch {
    Write-TestResult -Name "Health check helpers exist" -Passed $false -Error $_.Exception.Message
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
