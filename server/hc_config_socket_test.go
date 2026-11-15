package main

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// writeHcConfig writes herdr-core's config.toml under configHome.
func writeHcConfig(t *testing.T, configHome, text string) {
	t.Helper()
	dir := filepath.Join(configHome, "herdr-core")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestHcConfigSocket(t *testing.T) {
	home := t.TempDir()
	env := []string{"XDG_CONFIG_HOME=" + home}
	if got := hcConfigSocket(env); got != "" {
		t.Fatalf("no config.toml: got %q", got)
	}
	cases := []struct{ text, want string }{
		{"socket = '/run/me/core.sock'\nnotes = false\n", "/run/me/core.sock"},
		{`socket = '\\.\pipe\mine'`, `\\.\pipe\mine`},
		// herdr-core matches keys exactly (serde), and a file that does not
		// parse is ignored whole.
		{"Socket = '/x'\n", ""},
		{"socket = 7\n", ""},
		{"socket = ''\n", ""},
		{"socket = '/x'\nsocket = '/y'\n", ""},
		{"socket = '/x\n", ""},
		{"[core]\nsocket = '/x'\n", ""},
	}
	for _, c := range cases {
		writeHcConfig(t, home, c.text)
		if got := hcConfigSocket(env); got != c.want {
			t.Errorf("%q: got %q, want %q", c.text, got, c.want)
		}
	}
	// A config.toml too large to be a config is not read.
	writeHcConfig(t, home, "socket = '/x'\n#"+strings.Repeat("x", hcConfigMax))
	if got := hcConfigSocket(env); got != "" {
		t.Errorf("oversized config: got %q", got)
	}
}

// Without XDG_CONFIG_HOME the config is in the OS's config home
// (platform data_dirs): %APPDATA% on Windows, $HOME/.config elsewhere.
func TestHcConfigSocketDefaultHome(t *testing.T) {
	home := t.TempDir()
	var env []string
	if runtime.GOOS == "windows" {
		writeHcConfig(t, home, "socket = 'from-appdata'\n")
		env = []string{"APPDATA=" + home, "XDG_CONFIG_HOME="}
	} else {
		writeHcConfig(t, filepath.Join(home, ".config"), "socket = 'from-home'\n")
		env = []string{"HOME=" + home, "XDG_CONFIG_HOME="}
	}
	if got := hcConfigSocket(env); got == "" {
		t.Fatal("config in the default config home not read")
	}
}

// A core whose config.toml names its socket is found when core.lock does not
// name it (missing here; on Windows locked while the core runs).
func TestHcCoreRunningProbeConfigSocket(t *testing.T) {
	state, config := t.TempDir(), t.TempDir()
	env := []string{"XDG_STATE_HOME=" + state, "XDG_CONFIG_HOME=" + config, "HC_SESSION=cfg", "USERNAME=nobodyhere"}
	var sock string
	var ln net.Listener
	if runtime.GOOS == "windows" {
		sock = `\\.\pipe\termote-test-hc-config-` + filepath.Base(state)
		ln = hcTestListenPipe(t, sock)
	} else {
		sock = filepath.Join(shortTempDir(t), "c.sock")
		var err error
		if ln, err = net.Listen("unix", sock); err != nil {
			t.Fatal(err)
		}
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	if hcCoreRunningDefault(context.Background(), env) {
		t.Fatal("running with no config socket")
	}
	writeHcConfig(t, config, "socket = '"+sock+"'\n")
	if !hcCoreRunningDefault(context.Background(), env) {
		t.Fatal("core on the config.toml socket not found")
	}
	// HC_SOCKET wins over config.toml, as in hc.
	if hcCoreRunningDefault(context.Background(), append(env, "HC_SOCKET="+sock+".other")) {
		t.Fatal("config.toml used despite HC_SOCKET")
	}
}
