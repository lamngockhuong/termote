#!/bin/sh
# Release signatures in the format `ssh-keygen -Y verify` checks (SSHSIG,
# OpenSSH's PROTOCOL.sshsig), made with OpenSSL alone: ssh-keygen cannot read
# the release key, an Ed25519 key in PEM (PKCS#8), and the key is only ever
# handed to openssl.
#
#   release-sshsig.sh sign <key.pem> <file>     armored signature to stdout
#   release-sshsig.sh signer <key.pem|pub.pem>  the allowed-signers line
#
# The namespace is termote-release, so a signature made for another purpose
# with the same key never passes. The installers pin the allowed-signers
# line; a Go test keeps it equal to the PEM install.sh pins.
set -eu

NAMESPACE=termote-release

die() { echo "release-sshsig: $1" >&2; exit 1; }

# u32 <n>: n as 4 bytes, big-endian.
u32() {
  printf "\\$(printf %03o $(($1 >> 24 & 255)))\\$(printf %03o $(($1 >> 16 & 255)))"
  printf "\\$(printf %03o $(($1 >> 8 & 255)))\\$(printf %03o $(($1 & 255)))"
}

# sshstr <text>: an SSH wire string, its length then its bytes.
sshstr() { u32 ${#1}; printf '%s' "$1"; }

# sshfile <file>: the file's bytes as an SSH wire string.
sshfile() { u32 "$(wc -c <"$1" | tr -d ' ')"; cat "$1"; }

# pubblob <key> <dir>: the ssh-ed25519 public key blob of a PEM key (private
# or public) into <dir>/pub.blob.
pubblob() {
  if grep -q 'PRIVATE KEY' "$1"; then
    openssl pkey -in "$1" -pubout -outform DER >"$2/pub.der"
  else
    openssl pkey -pubin -in "$1" -outform DER >"$2/pub.der"
  fi
  [ "$(wc -c <"$2/pub.der" | tr -d ' ')" -eq 44 ] || die "$1 is not an Ed25519 key."
  tail -c 32 "$2/pub.der" >"$2/pub.raw"
  { sshstr ssh-ed25519; sshfile "$2/pub.raw"; } >"$2/pub.blob"
}

[ $# -ge 2 ] || die "usage: release-sshsig.sh sign <key.pem> <file> | signer <key.pem>"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/release-sshsig.XXXXXX") || die "could not create a temporary directory."
trap 'rm -rf "$WORK"' EXIT

case "$1" in
  signer)
    pubblob "$2" "$WORK"
    printf '%s ssh-ed25519 %s\n' "$NAMESPACE" "$(openssl base64 -A -in "$WORK/pub.blob")"
    ;;
  sign)
    [ $# -eq 3 ] || die "usage: release-sshsig.sh sign <key.pem> <file>"
    pubblob "$2" "$WORK"
    openssl dgst -sha512 -binary -out "$WORK/hash" "$3"
    { printf SSHSIG; sshstr "$NAMESPACE"; sshstr ""; sshstr sha512; sshfile "$WORK/hash"; } >"$WORK/signed"
    openssl pkeyutl -sign -inkey "$2" -rawin -in "$WORK/signed" -out "$WORK/sig.raw"
    { sshstr ssh-ed25519; sshfile "$WORK/sig.raw"; } >"$WORK/sig.blob"
    {
      printf SSHSIG
      u32 1
      sshfile "$WORK/pub.blob"
      sshstr "$NAMESPACE"
      sshstr ""
      sshstr sha512
      sshfile "$WORK/sig.blob"
    } >"$WORK/sshsig"
    echo "-----BEGIN SSH SIGNATURE-----"
    openssl base64 -A -in "$WORK/sshsig" | fold -w 70
    echo ""
    echo "-----END SSH SIGNATURE-----"
    ;;
  *) die "unknown command $1" ;;
esac
