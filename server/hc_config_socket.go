package main

import (
	"io"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
)

// hcConfigMax bounds herdr-core's config.toml.
const hcConfigMax = 64 << 10

// hcConfigSocket is `socket` in herdr-core's config.toml, where a core
// listens when HC_SOCKET is not set (herdr-core paths.rs; config.rs):
// $XDG_CONFIG_HOME (else the OS's config home)/herdr-core/config.toml. The
// key is matched exactly, as serde does, and a file that does not decode is
// ignored whole, as hc ignores it. It must be a regular file of at most
// hcConfigMax, opened without blocking.
func hcConfigSocket(env []string) string {
	base := hcEnvValue(env, "XDG_CONFIG_HOME")
	if base == "" {
		base = hcDefaultConfigHome(env)
	}
	f, err := os.OpenFile(filepath.Join(base, "herdr-core", "config.toml"), os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return ""
	}
	defer f.Close()
	if fi, err := f.Stat(); err != nil || !fi.Mode().IsRegular() || fi.Size() > hcConfigMax {
		return ""
	}
	b, err := io.ReadAll(io.LimitReader(f, hcConfigMax))
	if err != nil {
		return ""
	}
	var cfg map[string]any
	if _, err := toml.Decode(string(b), &cfg); err != nil {
		return ""
	}
	socket, _ := cfg["socket"].(string)
	return socket
}
