package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

const fixtureDir = "testdata/config"

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(fixtureDir, name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// fixtureKey is the passphrase testdata/config/config-linux was encrypted
// with (openssl enc -aes-256-cbc -a -A -salt -pbkdf2 -pass pass:<key>).
const fixtureKey = "80ce0cef6a04814998f604d765718f771574fe79a17747d84f980331e820d0fb"

func TestParseLinuxConfig(t *testing.T) {
	cfg, err := parseUnixConfig(readFixture(t, "config-linux"), func() string { return fixtureKey })
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.LAN || cfg.NoAuth || cfg.Port != 7700 || cfg.Tailscale != "box.tail1234.ts.net:8443" ||
		cfg.Password != "Linux-Pass-01" || cfg.Mux != "" || cfg.PasswordUnreadable || cfg.Container != nil {
		t.Fatalf("got %+v", *cfg)
	}
}

func TestParseConfigWrongSecretMarksPasswordUnreadable(t *testing.T) {
	cfg, err := parseUnixConfig(readFixture(t, "config-linux"), func() string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Password != "" || !cfg.PasswordUnreadable {
		t.Fatalf("password %q unreadable=%v, want empty and unreadable", cfg.Password, cfg.PasswordUnreadable)
	}
}

// A password stored as plain base64 is not accepted as-is: it is marked
// unreadable, so start sets a new one.
func TestParsePlainBase64AndEmptyPassword(t *testing.T) {
	key := func() string { return "unused" }
	cfg, _ := parseUnixConfig(readFixture(t, "config-plain-base64"), key)
	if cfg.Password != "" || !cfg.PasswordUnreadable {
		t.Fatalf("plain base64 password = %q unreadable=%v, want empty and unreadable", cfg.Password, cfg.PasswordUnreadable)
	}
	cfg, _ = parseUnixConfig(readFixture(t, "config-empty-pass"), key)
	if cfg.Password != "" || cfg.PasswordUnreadable || cfg.NoAuth {
		t.Fatalf("empty-pass config = %+v", *cfg)
	}
}

func TestUnixConfigRoundTrip(t *testing.T) {
	key := strings.Repeat("ab", 32)
	in := savedConfig{LAN: true, Port: 7700, Tailscale: "a.ts.net", Mux: "herdr",
		AllowHosts: []string{"mybox.local", "proxy.lan"}, HerdrAllowNoAuth: true, Password: `p@ss w0rd$!`,
		Container: &containerConfig{LAN: true, Port: 7681, Tailscale: "c.ts.net:8443", AllowHosts: []string{"c.lan"}, Workspace: "/work", Mux: "herdr", HerdrAllowNoAuth: true}}
	data, err := formatUnixConfig(in, key)
	if err != nil {
		t.Fatal(err)
	}
	out, err := parseUnixConfig(data, func() string { return key })
	if err != nil {
		t.Fatal(err)
	}
	if out.LAN != in.LAN || out.Port != in.Port || out.Tailscale != in.Tailscale ||
		out.Mux != in.Mux || strings.Join(out.AllowHosts, ",") != "mybox.local,proxy.lan" ||
		!out.HerdrAllowNoAuth || out.Password != in.Password {
		t.Fatalf("round trip: got %+v, want %+v", *out, in)
	}
	if cc := out.Container; cc == nil || !cc.LAN || cc.NoAuth || cc.Port != 7681 || cc.Tailscale != "c.ts.net:8443" ||
		strings.Join(cc.AllowHosts, ",") != "c.lan" || cc.Workspace != "/work" || cc.Mux != "herdr" || !cc.HerdrAllowNoAuth {
		t.Fatalf("container round trip: %+v", out.Container)
	}
	// A config saved before the container had a backend reads as none chosen.
	old := strings.NewReplacer("TERMOTE_CONTAINER_MUX=\"herdr\"\n", "", "TERMOTE_CONTAINER_HERDR_ALLOW_NO_AUTH=\"true\"\n", "").Replace(string(data))
	if old == string(data) {
		t.Fatalf("container backend keys not written:\n%s", data)
	}
	if prev, err := parseUnixConfig([]byte(old), func() string { return key }); err != nil || prev.Container == nil ||
		prev.Container.Mux != "" || prev.Container.HerdrAllowNoAuth || prev.Mux != "herdr" {
		t.Fatalf("config without the container backend: %+v, %v", prev, err)
	}
	if !strings.HasPrefix(string(data), "# Termote config (written by termote start)\nTERMOTE_LAN=\"true\"\n") {
		t.Fatalf("unexpected layout:\n%s", data)
	}
	if strings.Contains(string(data), "p@ss") {
		t.Fatal("password written in plain text")
	}
}

// The saved password is the `openssl enc -aes-256-cbc -pbkdf2` format, so the
// openssl command line can decrypt it.
func TestGoEncryptedPasswordDecryptsWithOpenSSL(t *testing.T) {
	if _, err := exec.LookPath("openssl"); err != nil {
		t.Skip("openssl not installed")
	}
	key := fixtureKey
	enc, err := encryptOpenSSL("Round-Trip-99", key)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("openssl", "enc", "-aes-256-cbc", "-a", "-A", "-d", "-salt", "-pbkdf2", "-pass", "pass:"+key)
	cmd.Stdin = strings.NewReader(enc + "\n")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("openssl could not decrypt %q: %v", enc, err)
	}
	if string(out) != "Round-Trip-99" {
		t.Fatalf("openssl decrypted %q", out)
	}
}

func TestDecryptRejectsTamperedCiphertextAndWrongKeys(t *testing.T) {
	enc, _ := encryptOpenSSL("secret", "k")
	if p, err := decryptSavedPassword(enc, passwordMAC(enc, "k"), "k"); err != nil || p != "secret" {
		t.Fatalf("good password: %q %v", p, err)
	}
	raw, _ := base64.StdEncoding.DecodeString(enc)
	raw[len(raw)-1] ^= 0xff
	tampered := base64.StdEncoding.EncodeToString(raw)
	for name, args := range map[string][3]string{
		"tampered ciphertext": {tampered, passwordMAC(enc, "k"), "k"},
		"garbage":             {"not base64!", passwordMAC("not base64!", "k"), "k"},
		"wrong key":           {enc, passwordMAC(enc, "k"), "other"},
		"no key":              {enc, passwordMAC(enc, ""), ""},
		"no MAC":              {enc, "", "k"},
	} {
		if _, err := decryptSavedPassword(args[0], args[1], args[2]); err == nil {
			t.Errorf("%s decrypted", name)
		}
	}
	// Without the MAC a wrong key decrypted about 1 time in 200; with it,
	// never.
	for i := range 1000 {
		key := strconv.Itoa(i)
		if _, err := decryptSavedPassword(enc, passwordMAC(enc, "k"), key); err == nil && key != "k" {
			t.Fatalf("key %q accepted", key)
		}
	}
}

func TestFormatUnixConfigRejectsQuotes(t *testing.T) {
	if _, err := formatUnixConfig(savedConfig{Tailscale: `a"b`}, "k"); err == nil {
		t.Fatal("quote in value accepted")
	}
}

// fakeDPAPI replaces DPAPI with "dpapi:" + data, as in the Windows fixture.
func fakeDPAPI(t *testing.T) {
	t.Helper()
	oldP, oldU := dpapiProtect, dpapiUnprotect
	dpapiProtect = func(b []byte) ([]byte, error) { return append([]byte("dpapi:"), b...), nil }
	dpapiUnprotect = func(b []byte) ([]byte, error) {
		if !bytes.HasPrefix(b, []byte("dpapi:")) {
			return nil, errors.New("not ours")
		}
		return b[len("dpapi:"):], nil
	}
	t.Cleanup(func() { dpapiProtect, dpapiUnprotect = oldP, oldU })
}

func TestParseWindowsConfig(t *testing.T) {
	fakeDPAPI(t)
	cfg, err := parseWindowsConfig(readFixture(t, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.LAN || cfg.Port != 7690 || cfg.Tailscale != "win.tail1234.ts.net" || cfg.Password != "Win-Pass-04" {
		t.Fatalf("got %+v", *cfg)
	}
}

func TestWindowsConfigRoundTrip(t *testing.T) {
	fakeDPAPI(t)
	in := savedConfig{Port: 7690, Mux: "tmux", AllowHosts: []string{"pc.lan"}, Password: "pw", Container: &containerConfig{Port: 7680, NoAuth: true, Mux: "herdr", HerdrAllowNoAuth: true}}
	data, err := formatWindowsConfig(in, time.Date(2026, 9, 25, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	out, err := parseWindowsConfig(data)
	if err != nil {
		t.Fatal(err)
	}
	if out.Container == nil || out.Container.Port != 7680 || !out.Container.NoAuth || out.Password != "pw" || out.Mux != "tmux" || strings.Join(out.AllowHosts, ",") != "pc.lan" ||
		out.Container.Mux != "herdr" || !out.Container.HerdrAllowNoAuth {
		t.Fatalf("round trip got %+v", *out)
	}
	// A config saved before the container had a backend reads as none chosen.
	prev, err := parseWindowsConfig([]byte(`{"Port":7690,"Mux":"herdr","Container":{"Lan":false,"NoAuth":false,"Port":7680}}`))
	if err != nil || prev.Container == nil || prev.Container.Mux != "" || prev.Container.HerdrAllowNoAuth {
		t.Fatalf("config without the container backend: %+v, %v", prev, err)
	}
}

func TestWindowsConfigUnreadablePassword(t *testing.T) {
	fakeDPAPI(t)
	cfg, err := parseWindowsConfig([]byte(`{"Mode":"native","EncryptedPass":"` + base64.StdEncoding.EncodeToString([]byte("other-user")) + `"}`))
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.PasswordUnreadable {
		t.Fatal("password from another user not flagged")
	}
}

func TestSaveAndLoadConfigFile(t *testing.T) {
	tc := newTestCLI(t, "linux")
	if cfg, err := tc.loadConfig(); cfg != nil || err != nil {
		t.Fatalf("missing config: %v %v", cfg, err)
	}
	if err := tc.saveConfig(savedConfig{Port: 7680, Mux: "tmux", Password: "pw1"}); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(tc.configFile())
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && st.Mode().Perm() != 0o600 {
		t.Fatalf("config mode %v, want 0600", st.Mode().Perm())
	}
	cfg, err := tc.loadConfig()
	if err != nil || cfg.Password != "pw1" {
		t.Fatalf("load: %+v %v", cfg, err)
	}
	// The key lives in its own owner-only file; without it the password is
	// unreadable, and the next save creates a new key.
	st, err = os.Stat(tc.secretFile())
	if err != nil || (runtime.GOOS != "windows" && st.Mode().Perm() != 0o600) || len(tc.readSecret()) != 64 {
		t.Fatalf("secret file: %v %v", st, err)
	}
	os.Remove(tc.secretFile())
	cfg, _ = tc.loadConfig()
	if cfg.Password != "" || !cfg.PasswordUnreadable {
		t.Fatalf("password readable without the secret: %+v", cfg)
	}
	if err := tc.saveConfig(savedConfig{Password: "pw2"}); err != nil {
		t.Fatal(err)
	}
	if cfg, _ = tc.loadConfig(); cfg.Password != "pw2" {
		t.Fatalf("after a new secret: %+v", cfg)
	}
}

func TestValidateHostName(t *testing.T) {
	for _, ok := range []string{"mybox.local", "192.168.1.5", "fe80::1", "a"} {
		if err := validateHostName(ok); err != nil {
			t.Errorf("%q rejected: %v", ok, err)
		}
	}
	for _, bad := range []string{"*", "", "a,b", "a b", `a"b`, "-x", "x/y"} {
		if err := validateHostName(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestGeneratePassword(t *testing.T) {
	p, err := generatePassword()
	if err != nil || len(p) != 12 || strings.Trim(p, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789") != "" {
		t.Fatalf("password %q, %v", p, err)
	}
}

func TestShowPassword(t *testing.T) {
	tc := newTestCLI(t, "linux")
	if code := tc.main([]string{"show-password"}); code != 1 {
		t.Fatalf("no config: code %d", code)
	}
	tc.saveConfig(savedConfig{Password: "Shown-01"})
	tc.stdout.Reset()
	if code := tc.main([]string{"show-password"}); code != 0 || !strings.Contains(tc.stdout.String(), "Password: Shown-01") {
		t.Fatalf("code %d out %q", code, tc.stdout.String())
	}
	tc.saveConfig(savedConfig{NoAuth: true})
	tc.stdout.Reset()
	if code := tc.main([]string{"show-password"}); code != 0 || !strings.Contains(tc.stdout.String(), "disabled") {
		t.Fatalf("no-auth: code %d out %q", code, tc.stdout.String())
	}
}
