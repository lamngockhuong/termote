<#
.SYNOPSIS
    Tests for scripts/install.ps1
.DESCRIPTION
    Runs the installer in this session with Invoke-RestMethod and
    Invoke-WebRequest replaced by functions that serve a local release, and
    LOCALAPPDATA pointed at a temp dir. A small Go program stands in for
    termote.exe and logs its arguments; another signs the fake releases'
    checksums.txt in the format ssh-keygen -Y verify checks, with a key made
    here that a copy of install.ps1 pins.
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
# sshsig signer <seed hex> | sshsig sign <seed hex> <in> <out>: the
# allowed-signers line of an Ed25519 key, or an SSHSIG signature of <in>.
$SshsigSrc = @'
package main

import (
	"crypto/ed25519"
	"crypto/sha512"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
)

// str is an SSH wire string: its length, then its bytes.
func str(b []byte) []byte {
	return append(binary.BigEndian.AppendUint32(nil, uint32(len(b))), b...)
}

func cat(parts ...[]byte) []byte {
	var out []byte
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

// sshsig signer <seed hex> | sshsig sign <seed hex> <in> <out>
func main() {
	seed, _ := hex.DecodeString(os.Args[2])
	key := ed25519.NewKeyFromSeed(seed)
	pub := cat(str([]byte("ssh-ed25519")), str(key.Public().(ed25519.PublicKey)))
	if os.Args[1] == "signer" {
		fmt.Println("termote-release ssh-ed25519 " + base64.StdEncoding.EncodeToString(pub))
		return
	}
	data, _ := os.ReadFile(os.Args[3])
	h := sha512.Sum512(data)
	ns := []byte("termote-release")
	signed := cat([]byte("SSHSIG"), str(ns), str(nil), str([]byte("sha512")), str(h[:]))
	sig := cat(str([]byte("ssh-ed25519")), str(ed25519.Sign(key, signed)))
	blob := cat([]byte("SSHSIG"), []byte{0, 0, 0, 1}, str(pub), str(ns), str(nil), str([]byte("sha512")), str(sig))
	b64 := base64.StdEncoding.EncodeToString(blob)
	var lines []string
	for len(b64) > 70 {
		lines, b64 = append(lines, b64[:70]), b64[70:]
	}
	lines = append(lines, b64)
	os.WriteFile(os.Args[4], []byte("-----BEGIN SSH SIGNATURE-----\n"+strings.Join(lines, "\n")+"\n-----END SSH SIGNATURE-----\n"), 0o644)
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

# Builds a Go program from $Source into $Out.
function Build-Go([string]$Source, [string]$Out) {
    $src = Join-Path $Tmp ("src-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $src -Force | Out-Null
    Set-Content (Join-Path $src 'go.mod') "module fake`n`ngo 1.24`n"
    Set-Content (Join-Path $src 'main.go') $Source
    Push-Location $src
    try { & go build -o $Out . } finally { Pop-Location }
}

# New-SignedRelease <version> [good|otherkey|none|unlisted]: a release whose
# checksums.txt lists its zip (or another name: unlisted), with a .sig and an
# .sshsig made with the test key (otherkey: another key; none: no .sshsig).
function New-SignedRelease([string]$Version, [string]$Mode = 'good') {
    New-Release $Version
    $name = "termote-$Version-windows-amd64"
    $dir = Join-Path $Releases "v$Version"
    $listed = if ($Mode -eq 'unlisted') { 'other.zip' } else { "$name.zip" }
    $hash = (Get-FileHash -Algorithm SHA256 (Join-Path $dir "$name.zip")).Hash.ToLower()
    $checksums = Join-Path $dir 'checksums.txt'
    [System.IO.File]::WriteAllText($checksums, "$hash  $listed`n")
    Set-Content (Join-Path $dir 'checksums.txt.sig') 'not checked here'
    $sigFile = Join-Path $dir 'checksums.txt.sshsig'
    Remove-Item $sigFile -ErrorAction SilentlyContinue
    $seed = if ($Mode -eq 'otherkey') { $OtherSeed } else { $Seed }
    if ($Mode -ne 'none') { & $SshsigExe sign $seed $checksums $sigFile }
}

function New-Release([string]$Version, [string]$Sum = 'good') {
    $name = "termote-$Version-windows-amd64"
    $stage = Join-Path $Tmp "stage\$name"
    New-Item -ItemType Directory -Path (Join-Path $stage 'bin') -Force | Out-Null
    Build-Go $EchoSrc (Join-Path $stage 'bin\termote.exe')
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

# Runs the installer (or $Script) with a fresh LOCALAPPDATA; returns whether
# it succeeded.
function Invoke-Installer([string]$Pin = '', [string]$Script = $InstallPath) {
    $env:TERMOTE_VERSION = $Pin
    $global:TermoteDownloads = @()
    # A transcript keeps what the installer printed even when it throws.
    $log = Join-Path $Tmp ("run-" + [guid]::NewGuid().ToString("N") + ".log")
    $ok = $true
    Start-Transcript -Path $log | Out-Null
    try { & $Script | Out-Host }
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
    $SshsigExe = Join-Path $Tmp 'sshsig.exe'
    Build-Go $SshsigSrc $SshsigExe
    $Seed = -join (1..32 | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
    $OtherSeed = -join (1..32 | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
    New-Release '1.0.1'
    New-Release '1.0.10'

    # Whoever publishes a release picks this version: an unsigned one needs a pin.
    $global:TermoteFakeTags = @('v1.0.1', 'v1.0.10')
    $ok = Invoke-Installer
    Write-TestResult "Unpinned release before 1.10.0 refused" ((-not $ok) -and $script:Out -match 'predates signed releases' -and
        -not ($global:TermoteDownloads -match 'releases/download')) $script:Out

    # Before the first release with an .sshsig the signature goes unchecked,
    # with a note, whether or not ssh-keygen is here.
    New-SignedRelease '1.10.1' 'none'
    New-SignedRelease '1.10.10' 'none'
    $global:TermoteFakeTags = @('v1.10.11:draft', 'v1.10.12:pre', 'v0.1.0', 'v1.0.10', 'v1.10.1', 'v1.10.10', 'v1.11.0-rc.1', 'latest')
    $ok = Invoke-Installer
    Write-TestResult "Fresh install succeeds" $ok $script:Out
    Write-TestResult "Says the signature was not checked" ($script:Out -match 'signature was not checked') $script:Out
    Write-TestResult "current.txt names the newest stable 1.x" ((Get-Current) -eq '1.10.10')
    Write-TestResult "Archive laid down as versions\<v>" (Test-Path (Join-Path $Dir 'versions\1.10.10\bin\termote.exe'))
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

    # A copy of install.ps1 pinning the test key checks the .sshsig of a
    # release from FirstSshsigVersion on with ssh-keygen -Y verify.
    $signed = Join-Path $Tmp 'install-signed.ps1'
    $signer = (& $SshsigExe signer $Seed | Out-String).Trim()
    $line = Get-Content $InstallPath | Where-Object { $_ -like '$ReleaseSigner = *' } | Select-Object -First 1
    $copy = (Get-Content $InstallPath -Raw).Replace($line, "`$ReleaseSigner = '$signer'")
    Set-Content -Path $signed -Value $copy
    Write-TestResult "Signed copy pins the test key" ($copy.Contains("'$signer'"))
    $first = ((Get-Content $InstallPath | Where-Object { $_ -match "^\`$FirstSshsigVersion = \[version\]'(.*)'" } | Select-Object -First 1) -replace ".*'(.*)'", '$1')
    $keygen = Get-Command ssh-keygen -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $keygen -or (& $keygen.Source -Y verify 2>&1 | Out-String) -match 'option -- Y') {
        Write-Host "[SKIP] no ssh-keygen -Y verify (OpenSSH 8.1 or later); signature tests" -ForegroundColor Yellow
    } else {
        foreach ($c in @(
                @{ Mode = 'good'; Ok = $true; Want = 'Signature verified' },
                @{ Mode = 'otherkey'; Ok = $false; Want = 'SIGNATURE CHECK FAILED' },
                @{ Mode = 'none'; Ok = $false; Want = 'has no checksums.txt.sshsig' },
                @{ Mode = 'unlisted'; Ok = $false; Want = 'does not vouch' })) {
            $env:LOCALAPPDATA = Join-Path $Tmp ("local-" + $c.Mode)
            $Dir = Join-Path $env:LOCALAPPDATA 'termote'
            New-SignedRelease $first $c.Mode
            $ok = Invoke-Installer $first $signed
            Write-TestResult "ssh-keygen $($c.Mode): $($c.Want)" ($ok -eq $c.Ok -and $script:Out -match $c.Want -and
                ($c.Ok -or -not (Test-Path (Join-Path $Dir 'current.txt')))) $script:Out
        }

        # An ssh-keygen before OpenSSH 8.1, with no -Y: installs with the note.
        $fakeBin = Join-Path $Tmp 'oldssh'
        New-Item -ItemType Directory -Path $fakeBin -Force | Out-Null
        if ([System.IO.Path]::DirectorySeparatorChar -eq '\') {
            Set-Content (Join-Path $fakeBin 'ssh-keygen.cmd') "@echo ssh-keygen: unknown option -- Y 1>&2`r`n@exit /b 1"
        } else {
            Set-Content (Join-Path $fakeBin 'ssh-keygen') "#!/bin/sh`necho 'ssh-keygen: unknown option -- Y' >&2`nexit 1"
            chmod +x (Join-Path $fakeBin 'ssh-keygen')
        }
        # PATH: Linux names environment variables with case.
        $savedPath = $env:PATH
        $env:PATH = "$fakeBin$([System.IO.Path]::PathSeparator)$env:PATH"
        try {
            $env:LOCALAPPDATA = Join-Path $Tmp 'local-oldssh'
            $Dir = Join-Path $env:LOCALAPPDATA 'termote'
            New-SignedRelease $first
            $ok = Invoke-Installer $first $signed
            Write-TestResult "Old ssh-keygen: installs with the note" ($ok -and $script:Out -match 'signature was not checked') $script:Out
        } finally { $env:PATH = $savedPath }
    }
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
