<#
.SYNOPSIS
    Termote installer for Windows.
.DESCRIPTION
    Downloads the release for this machine, verifies its sha256, lays it down
    under %LOCALAPPDATA%\termote and puts `termote` on the user PATH.

        irm https://termote.ohnice.app/install.ps1 | iex
        $env:TERMOTE_VERSION = '1.0.0'; irm https://termote.ohnice.app/install.ps1 | iex

    It never asks for administrator rights, never writes outside
    %LOCALAPPDATA%\termote (plus the user PATH), and never starts anything:
    it ends by printing `termote start`. TERMOTE_VERSION=X.Y.Z installs that
    exact release; with a version already installed it is the rescue path (the
    named version goes beside it and current points at it). GH_TOKEN only
    raises the GitHub API rate limit.
#>

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell 5.1 may default to TLS 1.0, which GitHub refuses.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$Repo = 'lamngockhuong/termote'
$Dir = Join-Path $env:LOCALAPPDATA 'termote'

function Stop-Install([string]$Message) {
    Write-Host "termote install: $Message" -ForegroundColor Red
    # `irm | iex` runs in the caller's session: throw instead of exit, so the
    # terminal stays open.
    throw "termote install failed"
}

$Pin = "$env:TERMOTE_VERSION".TrimStart('v')
# \z, not $: .NET's $ also matches before a trailing newline.
if ($Pin -and $Pin -notmatch '\A[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?\z') {
    Stop-Install "TERMOTE_VERSION='$Pin' is not a version. It has to look like 1.0.0, or 1.0.0-rc.1 for a pre-release."
}

# Windows on ARM runs the amd64 build.
$Name = $null
$Rescue = $false
# An install is a current pointer; without one (cut short, or uninstalled
# with its logs kept) the dir may hold only what an install leaves behind.
if (Test-Path (Join-Path $Dir 'current.txt')) {
    if (-not $Pin) {
        Write-Host "Termote is already installed at $Dir; leaving it alone."
        Write-Host "To move it forward, run:  termote update"
        Write-Host "To put one specific version there instead, set TERMOTE_VERSION=X.Y.Z and run this again."
        return
    }
    Write-Host "Termote is already installed at $Dir; laying $Pin down beside it and pointing current at it."
    $Rescue = $true
} elseif (Test-Path $Dir) {
    $foreign = Get-ChildItem $Dir -Force | Where-Object { $_.Name -notin @('versions', 'state', 'bin', 'previous.txt') -and $_.Name -notlike '.unpack-*' }
    if ($foreign) { Stop-Install "$Dir exists and is not a Termote install. Move it aside, then run this again." }
}

if ($Pin) {
    $Version = $Pin
} else {
    $headers = @{ Accept = 'application/vnd.github+json' }
    $token = if ($env:GH_TOKEN) { $env:GH_TOKEN } else { $env:GITHUB_TOKEN }
    if ($token) { $headers.Authorization = "Bearer $token" }
    try {
        $tags = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$Repo/tags?per_page=100"
    } catch {
        $code = [int]$_.Exception.Response.StatusCode
        if ($code -eq 403 -or $code -eq 429) {
            Stop-Install "GitHub's API rate limit says no (HTTP $code). Set GH_TOKEN to a token with no scopes, wait an hour, or name the version: `$env:TERMOTE_VERSION='X.Y.Z'"
        }
        Stop-Install "could not list the releases on GitHub ($($_.Exception.Message)). Name the version instead: `$env:TERMOTE_VERSION='X.Y.Z'"
    }
    # The newest stable 1.x tag; releases/latest can name a 0.x release.
    $Version = $tags | ForEach-Object { $_.name } | Where-Object { $_ -match '^v[0-9]+\.[0-9]+\.[0-9]+$' } |
        ForEach-Object { [version]$_.TrimStart('v') } | Where-Object { $_.Major -ge 1 } |
        Sort-Object -Descending | Select-Object -First 1
    if (-not $Version) { Stop-Install "no 1.x release found for $Repo. Name one with `$env:TERMOTE_VERSION='X.Y.Z'" }
    $Version = "$Version"
}

$Exe = Join-Path $Dir "versions\$Version\bin\termote.exe"

function Set-Current {
    # current.txt names the version; written through a temp file and a rename
    # so it is never half written.
    $tmp = Join-Path $Dir 'current.txt.tmp'
    Set-Content -Path $tmp -Value $Version -NoNewline -Encoding ASCII
    Move-Item -Path $tmp -Destination (Join-Path $Dir 'current.txt') -Force
}

function Complete-Install {
    # `link` writes bin\termote.cmd and puts that dir on the user PATH.
    & $Exe link
    if ($LASTEXITCODE -ne 0) { Write-Host "note: 'termote link' did not finish; run '$Exe link' to see why." -ForegroundColor Yellow }
    $env:Path = "$(Join-Path $Dir 'bin');$env:Path"
    Write-Host ""
    Write-Host "Termote $Version is installed at $Dir, and nothing is running yet."
    Write-Host "Start it (see 'termote help' for options such as --lan):"
    Write-Host ""
    Write-Host "  termote start"
    Write-Host ""
}

if ($Rescue -and (Test-Path $Exe)) {
    Set-Current
    Write-Host "Termote $Version was already in $Dir\versions; current now points at it and nothing was downloaded."
    Complete-Install
    return
}

$Name = "termote-$Version-windows-amd64"
$Base = "https://github.com/$Repo/releases/download/v$Version"
$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("termote-install-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Tmp -Force | Out-Null
try {
    Write-Host "Downloading Termote $Version for windows-amd64..."
    try { Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Name.zip" -OutFile (Join-Path $Tmp "$Name.zip") }
    catch { Stop-Install "release $Version has no windows-amd64 archive: the version does not exist, or it was released a few minutes ago and is still publishing (retry then). See https://github.com/$Repo/releases" }
    try { Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Name.zip.sha256" -OutFile (Join-Path $Tmp "$Name.zip.sha256") }
    catch { Stop-Install "could not download $Name.zip.sha256; refusing to install an unverified binary." }

    $fields = (Get-Content (Join-Path $Tmp "$Name.zip.sha256") -Raw).Trim() -split '\s+'
    if ($fields.Count -lt 2 -or $fields[1].TrimStart('*') -ne "$Name.zip") {
        Stop-Install "$Name.zip.sha256 does not list $Name.zip; refusing to install an unverified binary."
    }
    $expected = $fields[0]
    $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $Tmp "$Name.zip")).Hash
    if (-not $expected -or $expected -ne $actual) {
        Stop-Install "CHECKSUM MISMATCH for $Name.zip: the download was discarded and nothing was installed. Try again; if it repeats, report it."
    }

    Expand-Archive -Path (Join-Path $Tmp "$Name.zip") -DestinationPath $Tmp -Force
    if (-not (Test-Path (Join-Path $Tmp "$Name\bin\termote.exe"))) {
        Stop-Install "$Name.zip does not contain bin\termote.exe; refusing to install it."
    }
    New-Item -ItemType Directory -Path (Join-Path $Dir 'versions') -Force | Out-Null
    $dest = Join-Path $Dir "versions\$Version"
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Move-Item -Path (Join-Path $Tmp $Name) -Destination $dest
} finally {
    Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
Set-Current
Complete-Install
