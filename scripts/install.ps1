<#
.SYNOPSIS
    Termote installer for Windows.
.DESCRIPTION
    Downloads the release for this machine, verifies its sha256 and, with
    ssh-keygen -Y verify (OpenSSH 8.1 or later), its signature, lays it down
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

# From 1.10.0 on, a release's checksums.txt is signed by the release
# workflow, once a release is approved; from FirstSshsigVersion on it also
# carries checksums.txt.sshsig, the same key's signature in the format
# ssh-keygen -Y verify checks. This is that key as an allowed-signers line
# (a Go test keeps it equal to the one install.sh pins).
# BEGIN RELEASE SIGNER
$ReleaseSigner = 'termote-release ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDq+5Oa2sxWyj1xx7qUaqQt7tUFCdVOhEiYITPbrPT2g'
# END RELEASE SIGNER
$FirstSshsigVersion = [version]'2.14.0'

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
# The server's cache dir is LOCALAPPDATA too, so its trash (kept by
# uninstall) and uploads sit here as well.
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
    $foreign = Get-ChildItem $Dir -Force | Where-Object { $_.Name -notin @('versions', 'state', 'bin', 'previous.txt', 'trash', 'uploads') -and $_.Name -notlike '.unpack-*' }
    if ($foreign) { Stop-Install "$Dir exists and is not a Termote install. Move it aside, then run this again." }
}

if ($Pin) {
    $Version = $Pin
} else {
    $headers = @{ Accept = 'application/vnd.github+json' }
    $token = if ($env:GH_TOKEN) { $env:GH_TOKEN } else { $env:GITHUB_TOKEN }
    if ($token) { $headers.Authorization = "Bearer $token" }
    try {
        $releases = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$Repo/releases?per_page=30"
    } catch {
        $code = [int]$_.Exception.Response.StatusCode
        if ($code -eq 403 -or $code -eq 429) {
            Stop-Install "GitHub's API rate limit says no (HTTP $code). Set GH_TOKEN to a token with no scopes, wait an hour, or name the version: `$env:TERMOTE_VERSION='X.Y.Z'"
        }
        Stop-Install "could not list the releases on GitHub ($($_.Exception.Message)). Name the version instead: `$env:TERMOTE_VERSION='X.Y.Z'"
    }
    # The newest published stable 1.x release; releases/latest can name a 0.x
    # release. Not the tag list: release-please pushes the tag while the
    # release is still a draft waiting for approval, with no archive yet. A
    # token with push access also lists drafts.
    $Version = $releases | Where-Object { -not $_.draft -and -not $_.prerelease } | ForEach-Object { $_.tag_name } |
        Where-Object { $_ -match '^v[0-9]+\.[0-9]+\.[0-9]+$' } |
        ForEach-Object { [version]$_.TrimStart('v') } | Where-Object { $_.Major -ge 1 } |
        Sort-Object -Descending | Select-Object -First 1
    if (-not $Version) { Stop-Install "no 1.x release found for $Repo. Name one with `$env:TERMOTE_VERSION='X.Y.Z'" }
    $Version = "$Version"
}

# 1.10.0 and later, a 1.10.0 pre-release excepted, as `termote update` counts.
function Test-ReleaseSigned([string]$V) {
    $core = [version](($V -split '-', 2)[0])
    return $core -gt [version]'1.10.0' -or ($core -eq [version]'1.10.0' -and $V -notmatch '-')
}

# Whoever can publish a release picks the unpinned version: never let it be
# one with no signature to check.
if (-not $Pin -and -not (Test-ReleaseSigned $Version)) {
    Stop-Install "the newest release for $Repo, $Version, predates signed releases (1.10.0); refusing to install it without a pin. If you mean it: `$env:TERMOTE_VERSION='$Version'"
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

# Invoke-Native runs $Exe with $Arguments (one command line: quote paths),
# its stdin the bytes of $StdinFile as they are (Start-Process would rewrite
# its lines), and returns its exit code and output.
function Invoke-Native([string]$Exe, [string]$Arguments, [string]$StdinFile) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo $Exe, $Arguments
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    if ($StdinFile) {
        $bytes = [System.IO.File]::ReadAllBytes($StdinFile)
        $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    }
    $p.StandardInput.Close()
    # A few lines each: reading one after the other cannot fill a pipe.
    $text = $p.StandardOutput.ReadToEnd() + $p.StandardError.ReadToEnd()
    $p.WaitForExit()
    return @{ Code = $p.ExitCode; Text = $text }
}

# Get-SshKeygen: the path of an ssh-keygen with -Y verify, or $null. One
# before OpenSSH 8.1 says "unknown option -- Y".
function Get-SshKeygen {
    $cmd = Get-Command ssh-keygen -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmd) { return $null }
    if ((Invoke-Native $cmd.Source '-Y verify' $null).Text -match 'option -- Y') { return $null }
    return $cmd.Source
}

# Confirm-Signature: checks the release's signed checksums.txt with
# ssh-keygen -Y verify and that it lists $Name.zip with the sha256 $Actual.
# Without such an ssh-keygen it says the signature was not checked.
function Confirm-Signature([string]$Actual) {
    $checksums = Join-Path $Tmp 'checksums.txt'
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$Base/checksums.txt" -OutFile $checksums
        Invoke-WebRequest -UseBasicParsing -Uri "$Base/checksums.txt.sig" -OutFile (Join-Path $Tmp 'checksums.txt.sig')
    } catch { Stop-Install "release $Version has no signed checksums.txt; refusing to install it." }
    $keygen = Get-SshKeygen
    $sshsig = Join-Path $Tmp 'checksums.txt.sshsig'
    $haveSshsig = $false
    if ($keygen) {
        try { Invoke-WebRequest -UseBasicParsing -Uri "$Base/checksums.txt.sshsig" -OutFile $sshsig; $haveSshsig = $true } catch {}
        if (-not $haveSshsig -and [version](($Version -split '-', 2)[0]) -ge $FirstSshsigVersion) {
            Stop-Install "release $Version has no checksums.txt.sshsig; refusing to install it."
        }
    }
    if (-not $haveSshsig) {
        Write-Host "note: the release signature was not checked (the sha256 was): this needs ssh-keygen -Y verify (OpenSSH 8.1 or later) and release $FirstSshsigVersion or later. 'termote update' checks it from now on." -ForegroundColor Yellow
        return
    }
    $allowed = Join-Path $Tmp 'allowed_signers'
    [System.IO.File]::WriteAllText($allowed, "$ReleaseSigner`n")
    $verify = Invoke-Native $keygen "-Y verify -f `"$allowed`" -I termote-release -n termote-release -s `"$sshsig`"" $checksums
    if ($verify.Code -ne 0) {
        Stop-Install "SIGNATURE CHECK FAILED for release ${Version}: its checksums.txt is not signed by the Termote release key. Nothing was installed; report it."
    }
    $signed = Get-Content $checksums | ForEach-Object {
        $f = $_.Trim() -split '\s+'
        if ($f.Count -eq 2 -and $f[1].TrimStart('*') -eq "$Name.zip") { $f[0] }
    } | Select-Object -First 1
    if (-not $signed -or $signed -ne $Actual) {
        Stop-Install "the signed checksums.txt does not vouch for $Name.zip; nothing was installed."
    }
    Write-Host "Signature verified."
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

    if (Test-ReleaseSigned $Version) {
        Confirm-Signature $actual
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
