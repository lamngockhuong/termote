package main

import (
	"path"
	"path/filepath"
	"strings"
)

// sensitiveNames match a file's base name (lowercased): files that usually
// hold secrets. A match only asks the user to confirm before showing the
// contents; it is a warning, not a boundary (that is filesDenied).
var sensitiveNames = []string{
	".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "*.kdbx", "*.keystore",
	"id_rsa*", "id_dsa*", "id_ecdsa*", "id_ed25519*",
	".netrc", ".npmrc", ".pypirc", ".pgpass", ".git-credentials", "credentials*",
	".credentials.json", "secrets.*", "*.tfstate", "*.tfstate.*", ".htpasswd",
	"*service-account*.json", ".terraformrc",
}

// sensitiveDirs: everything under a directory of this name (lowercased path
// components, "/"-separated for nested ones) is sensitive.
var sensitiveDirs = []string{".ssh", ".gnupg", ".aws", ".kube", ".docker", ".config/gh", ".config/gcloud"}

// isSensitive reports whether an absolute path names a file that usually
// holds secrets, by its base name or a directory above it.
func isSensitive(p string) bool {
	parts := strings.Split(strings.ToLower(filepath.ToSlash(filepath.Clean(p))), "/")
	base := parts[len(parts)-1]
	for _, pat := range sensitiveNames {
		if ok, _ := path.Match(pat, base); ok {
			return true
		}
	}
	dirs := "/" + strings.Join(parts[:len(parts)-1], "/") + "/"
	for _, d := range sensitiveDirs {
		if strings.Contains(dirs, "/"+d+"/") {
			return true
		}
	}
	return false
}
