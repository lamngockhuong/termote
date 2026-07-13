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
    $hasTtyd = $content -match '\[string\]\$Ttyd'
    $allExist = $hasCommand -and $hasMode -and $hasLan -and $hasNoAuth -and $hasPort -and $hasTtyd
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
# Test 13: ttyd source selection wired (official vs fork)
# ─────────────────────────────────────────────────────────────
try {
    $content = Get-Content $ScriptPath -Raw
    $hasSources     = $content -match '\$script:TTYD_SOURCES'
    $hasForkAsset   = $content -match 'ttyd\.msvc\.exe'
    $hasOffAsset    = $content -match 'ttyd\.win32\.exe'
    $hasDefault     = $content -match '\$script:TTYD_DEFAULT_SOURCE\s*=\s*"fork"'
    $hasSourceParam = $content -match 'Get-TtydBinary[\s\S]{0,200}\$Source'
    $allExist = $hasSources -and $hasForkAsset -and $hasOffAsset -and $hasDefault -and $hasSourceParam
    Write-TestResult -Name "ttyd source selection wired" -Passed $allExist
} catch {
    Write-TestResult -Name "ttyd source selection wired" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 14: update command wired (function, helper, params, dispatch)
# ─────────────────────────────────────────────────────────────
try {
    $content = Get-Content $ScriptPath -Raw
    $hasUpdateFn   = $content -match "function Invoke-Update"
    $hasVersionApi = $content -match "function Get-LatestVersionApi"
    $hasVersionP   = $content -match '\[string\]\$Version'
    $hasForceP     = $content -match '\[switch\]\$Force'
    $inValidateSet = $content -match '"version",\s*"update"' -or $content -match '"update"[\s\S]{0,40}\$Command'
    $hasDispatch   = $content -match '"update"\s*\{[\s\S]{0,80}Invoke-Update'
    $allExist = $hasUpdateFn -and $hasVersionApi -and $hasVersionP -and $hasForceP -and $inValidateSet -and $hasDispatch
    Write-TestResult -Name "update command wired" -Passed $allExist
} catch {
    Write-TestResult -Name "update command wired" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 15: update git-guard + SHA256 verify present (no network in source)
# ─────────────────────────────────────────────────────────────
try {
    $content = Get-Content $ScriptPath -Raw
    $hasGitGuard = $content -match 'Cannot update from a git repo'
    $hasChecksum = $content -match 'Get-FileHash[\s\S]{0,80}SHA256' -or $content -match "-Algorithm SHA256"
    $preservesTtyd = $content -match '\$savedConfig\.Ttyd'
    Write-TestResult -Name "update git-guard + SHA256 + Ttyd preserved" -Passed ($hasGitGuard -and $hasChecksum -and $preservesTtyd)
} catch {
    Write-TestResult -Name "update git-guard + SHA256 + Ttyd preserved" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 16: logs follow/clean branch + service guard present
# ─────────────────────────────────────────────────────────────
try {
    $content = Get-Content $ScriptPath -Raw
    $hasFollow  = $content -match '@\("follow",\s*"tail"\)'
    $hasGuard   = $content -match 'Unknown log service'
    $hasClean   = $content -match '"clean"\s*\{'
    Write-TestResult -Name "logs follow/clean + service guard" -Passed ($hasFollow -and $hasGuard -and $hasClean)
} catch {
    Write-TestResult -Name "logs follow/clean + service guard" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 17: interactive menu lists Update + Clean logs
# ─────────────────────────────────────────────────────────────
try {
    $content = Get-Content $ScriptPath -Raw
    $hasUpdateOpt = $content -match 'Select-Option[\s\S]{0,300}"Update"'
    $hasCleanOpt  = $content -match '"Clean logs"'
    $hasUpdateCase = $content -match '"Update\*"\s*\{[\s\S]{0,60}Invoke-Update'
    $hasCleanCase  = $content -match '"Clean logs\*"\s*\{[\s\S]{0,80}clean'
    $allExist = $hasUpdateOpt -and $hasCleanOpt -and $hasUpdateCase -and $hasCleanCase
    Write-TestResult -Name "menu lists Update + Clean logs" -Passed $allExist
} catch {
    Write-TestResult -Name "menu lists Update + Clean logs" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 18: behavioral — help output + update validation (no network)
# ─────────────────────────────────────────────────────────────
# Guards fire before any download, so these child-process runs are safe:
#   - `help`             prints usage and exits 0
#   - `update -Version bad` fails format validation (exit 1) before network
#   - `update` from this git checkout hits the git-repo guard before network
try {
    $psExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { "pwsh" } else { "powershell" }

    $helpOut = (& $psExe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath help 2>&1 | Out-String)
    $helpOk = ($helpOut -match '\bupdate\b') -and ($helpOut -match 'logs follow') -and ($helpOut -match 'logs clean')
    Write-TestResult -Name "help output lists update + logs follow/clean" -Passed $helpOk -Error "help output missing new commands"

    $badOut = (& $psExe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath update -Version "bad" 2>&1 | Out-String)
    $badCode = $LASTEXITCODE
    $badOk = ($badOut -match 'Invalid version format') -and ($badCode -ne 0) -and ($badOut -notmatch 'Downloading')
    Write-TestResult -Name "update rejects malformed -Version (no network)" -Passed $badOk -Error "expected format error, got: $badOut"

    $guardOut = (& $psExe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath update 2>&1 | Out-String)
    $guardCode = $LASTEXITCODE
    $guardOk = ($guardOut -match 'Cannot update from a git repo') -and ($guardCode -ne 0) -and ($guardOut -notmatch 'Downloading')
    Write-TestResult -Name "update refuses git repo before download" -Passed $guardOk -Error "expected git-guard error, got: $guardOut"
} catch {
    Write-TestResult -Name "update behavioral checks" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 19: behavioral — logs subcommands validate (ValidateSet removed)
# ─────────────────────────────────────────────────────────────
# `logs ttyd` must NOT throw a parameter-binding error (the old $Mode ValidateSet
# blocked it); `logs badservice` must hit the contextual service guard.
try {
    $psExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { "pwsh" } else { "powershell" }

    $ttydOut = (& $psExe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath logs ttyd 2>&1 | Out-String)
    # No "ParameterBindingValidationException" / "does not belong to the set" → binding OK
    $ttydOk = ($ttydOut -notmatch 'does not belong to the set') -and ($ttydOut -notmatch 'ParameterBindingValidation')
    Write-TestResult -Name "logs ttyd validates (no binding error)" -Passed $ttydOk -Error "got: $ttydOut"

    $badOut = (& $psExe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath logs badservice 2>&1 | Out-String)
    $badCode = $LASTEXITCODE
    $badOk = ($badOut -match 'Unknown log service') -and ($badCode -ne 0)
    Write-TestResult -Name "logs rejects unknown service" -Passed $badOk -Error "expected guard error, got: $badOut"
} catch {
    Write-TestResult -Name "logs behavioral checks" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 20b: log viewer includes *-error.log (stderr) files (regression)
# ─────────────────────────────────────────────────────────────
# On Windows services log to *-error.log via -RedirectStandardError; a viewer
# reading only "<svc>.log" (stdout) shows nothing. Assert Write-LogTail exists
# and ttyd/all glob so the error logs are included.
try {
    $content = Get-Content $ScriptPath -Raw
    $hasHelper = $content -match 'function Write-LogTail'
    $ttydGlob  = $content -match 'Write-LogTail -Pattern "ttyd\*\.log"'
    $allGlob   = $content -match 'Write-LogTail -Pattern "\*\.log"'
    Write-TestResult -Name "log viewer includes *-error.log" -Passed ($hasHelper -and $ttydGlob -and $allGlob)
} catch {
    Write-TestResult -Name "log viewer includes *-error.log" -Passed $false -Error $_.Exception.Message
}

# ─────────────────────────────────────────────────────────────
# Test 20: interactive install answers are authoritative (regression)
# ─────────────────────────────────────────────────────────────
# Guards against the saved-config-override bug: an explicit "No" to LAN/Auth/
# Tailscale must set the $opts key so Invoke-Install's merge doesn't re-apply a
# stale saved value. Assert Show-InteractiveInstall assigns the keys directly
# (not the old `if (Confirm-Action ...) { $opts.Lan = $true }` conditional form).
try {
    $content = Get-Content $ScriptPath -Raw
    $lanAuthoritative = $content -match '\$opts\.Lan\s*=\s*\[bool\]\(Confirm-Action'
    $noAuthAuthoritative = $content -match '\$opts\.NoAuth\s*=\s*\[bool\]\(Confirm-Action'
    $tsInitialized = $content -match '\$opts\.Tailscale\s*=\s*""'
    $allExist = $lanAuthoritative -and $noAuthAuthoritative -and $tsInitialized
    Write-TestResult -Name "interactive install answers authoritative" -Passed $allExist
} catch {
    Write-TestResult -Name "interactive install answers authoritative" -Passed $false -Error $_.Exception.Message
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
