<#
.SYNOPSIS
    Tests for get.ps1 (Windows online installer)
.DESCRIPTION
    Runs get.ps1 end to end in-process. Functions named Invoke-RestMethod and
    Invoke-WebRequest shadow the cmdlets and serve a local release (tarball +
    checksums.txt); the release's termote.ps1 logs how it was called.
    Run from repo root: ./tests/test-get.ps1
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
Write-Host "=== Termote get.ps1 Tests ===" -ForegroundColor Cyan
Write-Host ""

$TestDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$GetPath = [System.IO.Path]::GetFullPath((Join-Path $TestDir "../scripts/get.ps1"))

$errors = $null
$null = [System.Management.Automation.PSParser]::Tokenize((Get-Content $GetPath -Raw), [ref]$errors)
Write-TestResult "Syntax valid" ($errors.Count -eq 0) ($errors | Select-Object -First 1)
$getText = Get-Content $GetPath -Raw
Write-TestResult "No ttyd download step" (-not ($getText -match 'ttyd\.(win32|msvc)|lamngockhuong/ttyd'))

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("termote-get-test-" + [guid]::NewGuid().ToString("N"))
$Releases = Join-Path $Tmp "releases"
$script:ShimLog = Join-Path $Tmp "shim.log"
$global:TermoteTestLatest = "1.0.0"

# New-Release <version> [good|bad|none]: tarball whose termote.ps1 logs its call
function New-Release([string]$Version, [string]$Sums = "good") {
    $stage = Join-Path $Tmp "stage/$Version/termote-v$Version"
    New-Item -ItemType Directory -Path (Join-Path $stage "scripts") -Force | Out-Null
    Set-Content -Path (Join-Path $stage "scripts/termote.ps1") -Value @"
param([string]`$Command, [string]`$Mode, [switch]`$Lan, [switch]`$NoAuth)
`$line = "`$Command `$Mode" + `$(if (`$Lan) { ' -Lan' }) + `$(if (`$NoAuth) { ' -NoAuth' })
Add-Content -Path '$script:ShimLog' -Value `$line
exit 0
"@
    Set-Content -Path (Join-Path $stage "README.md") -Value "payload $Version"
    $dir = Join-Path $Releases $Version
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $tarball = Join-Path $dir "termote-v$Version.tar.gz"
    tar -czf $tarball -C (Split-Path -Parent $stage) "termote-v$Version"
    $hash = (Get-FileHash $tarball -Algorithm SHA256).Hash.ToLower()
    if ($Sums -eq "bad") { $hash = "0" * 64 }
    if ($Sums -ne "none") { Set-Content -Path (Join-Path $dir "checksums.txt") -Value "$hash  termote-v$Version.tar.gz" }
}

# Shadow the web cmdlets: get.ps1 resolves these functions first. They read
# globals: inside get.ps1, $script: would mean get.ps1's own scope.
function Invoke-RestMethod {
    param([Parameter(Position = 0)][string]$Uri)
    return [pscustomobject]@{ tag_name = "v$global:TermoteTestLatest" }
}
function Invoke-WebRequest {
    param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
    $rest = $Uri -replace '^.*/releases/download/v', ''
    $file = Join-Path $Releases $rest
    if (-not (Test-Path $file)) { throw "404 Not Found: $Uri" }
    if ($OutFile) { Copy-Item $file $OutFile; return }
    return [pscustomobject]@{ Content = (Get-Content $file -Raw) }
}

# Invoke-Get <case> <params hashtable> [config.json object]: fresh profile dir
function Invoke-Get([string]$Case, [hashtable]$Params, $Config = $null) {
    $profileDir = Join-Path $Tmp "profile-$Case"
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    $env:USERPROFILE = $profileDir
    $env:TERMOTE_INSTALL_DIR = Join-Path $profileDir ".termote"
    if ($Config) {
        New-Item -ItemType Directory -Path $env:TERMOTE_INSTALL_DIR -Force | Out-Null
        $Config | ConvertTo-Json | Set-Content (Join-Path $env:TERMOTE_INSTALL_DIR "config.json")
    }
    Set-Content -Path $script:ShimLog -Value $null
    $script:Output = (& $GetPath @Params 6>&1 2>&1 | ForEach-Object { "$_" }) -join "`n"
    $script:Install = $env:TERMOTE_INSTALL_DIR
    $script:Calls = (Get-Content $script:ShimLog | Where-Object { $_ }) -join ";"
}

$savedEnv = @{}
foreach ($name in @("USERPROFILE", "TERMOTE_INSTALL_DIR", "TERMOTE_AUTO_YES", "TERMOTE_DOWNLOAD_ONLY", "TERMOTE_UPDATE", "TERMOTE_MODE", "TERMOTE_LAN", "TERMOTE_NO_AUTH", "TERMOTE_TTYD")) {
    $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name)
    if ($name -notin @("USERPROFILE")) { [Environment]::SetEnvironmentVariable($name, $null) }
}

try {
    New-Release "1.0.0"

    Invoke-Get "default" @{ Yes = $true }
    Test-Equal "Extracts into the install dir" "payload 1.0.0" ((Get-Content (Join-Path $Install "README.md") -ErrorAction SilentlyContinue) -join "")
    Test-Equal "Writes .version" "1.0.0" ((Get-Content (Join-Path $Install ".version") -Raw -ErrorAction SilentlyContinue))
    Test-Equal "Runs install native" "install native" $Calls
    Write-TestResult "Verifies the checksum" ($Output -match "Checksum verified") $Output

    Invoke-Get "flags" @{ Yes = $true; Lan = $true; NoAuth = $true; Mode = "container" }
    Test-Equal "Passes mode, -Lan and -NoAuth" "install container -Lan -NoAuth" $Calls

    Invoke-Get "ttyd" @{ Yes = $true; Ttyd = "fork" }
    Write-TestResult "-Ttyd only warns" (($Output -match "ignored") -and ($Calls -eq "install native")) "$Calls | $Output"

    Invoke-Get "download" @{ DownloadOnly = $true }
    Test-Equal "-DownloadOnly runs nothing" "" $Calls
    Write-TestResult "-DownloadOnly extracts" (Test-Path (Join-Path $Install "scripts/termote.ps1"))

    $env:TERMOTE_UPDATE = "true"
    Invoke-Get "update" @{} ([pscustomobject]@{ Mode = "container"; Lan = $true; Port = 7700 })
    Test-Equal "TERMOTE_UPDATE uses the saved mode; install merges the rest" "install container" $Calls
    Invoke-Get "update-noconfig" @{}
    Write-TestResult "Update without config fails" (($Output -match "No saved config") -and -not $Calls) "$Calls | $Output"
    $env:TERMOTE_UPDATE = $null

    $global:TermoteTestLatest = "0.9.0"
    New-Release "0.9.0" "bad"
    Invoke-Get "mismatch" @{ Yes = $true }
    Write-TestResult "Checksum mismatch fails" ($Output -match "Checksum mismatch") $Output
    Write-TestResult "Mismatch extracts and runs nothing" ((-not (Test-Path (Join-Path $Install "README.md"))) -and -not $Calls) $Calls

    $global:TermoteTestLatest = "0.8.0"
    New-Release "0.8.0" "none"
    Invoke-Get "nosums" @{ Yes = $true }
    Write-TestResult "Missing checksums only warn" (($Output -match "skipping verification") -and ($Calls -eq "install native")) "$Calls | $Output"
} finally {
    Remove-Variable -Name TermoteTestLatest -Scope Global -ErrorAction SilentlyContinue
    foreach ($name in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnv[$name]) }
    Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "=== Results ===" -ForegroundColor Cyan
Write-Host "Passed: $script:TestsPassed" -ForegroundColor Green
Write-Host "Failed: $script:TestsFailed" -ForegroundColor $(if ($script:TestsFailed -gt 0) { "Red" } else { "Green" })
if ($script:TestsFailed -gt 0) { exit 1 }
