package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const fixtureDir = "testdata/config-0.1.0"

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(fixtureDir, name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestDeriveKeyMatchesZeroX(t *testing.T) {
	// echo -n "termote-box-tester-termote" | openssl dgst -sha256 -r
	const want = "80ce0cef6a04814998f604d765718f771574fe79a17747d84f980331e820d0fb"
	if got := deriveKey("termote-box", "tester"); got != want {
		t.Fatalf("deriveKey = %s, want %s", got, want)
	}
}

func TestMachineKeyUsesHostnameAndWhoamiCommands(t *testing.T) {
	tc := newTestCLI(t, "linux")
	if got, want := tc.machineKey(), deriveKey("termote-box", "tester"); got != want {
		t.Fatalf("machineKey = %s, want %s", got, want)
	}
}

func TestParseZeroXLinuxConfig(t *testing.T) {
	cfg, err := parseUnixConfig(readFixture(t, "config-linux"), func() string { return deriveKey("termote-box", "tester") })
	if err != nil {
		t.Fatal(err)
	}
	want := savedConfig{Mode: "native", LAN: true, Port: 7700, Tailscale: "box.tail1234.ts.net:8443", Password: "Linux-Pass-01"}
	if cfg.Mode != want.Mode || cfg.LAN != want.LAN || cfg.NoAuth || cfg.Port != want.Port ||
		cfg.Tailscale != want.Tailscale || cfg.Password != want.Password || cfg.Mux != "" || cfg.PasswordUnreadable {
		t.Fatalf("got %+v, want %+v", *cfg, want)
	}
}

func TestParseZeroXMacConfig(t *testing.T) {
	cfg, err := parseUnixConfig(readFixture(t, "config-macos"), func() string { return deriveKey("Testers-Mac-mini.local", "tester") })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Mode != "container" || cfg.Port != 7680 || cfg.Password != "Mac-Pass-02" {
		t.Fatalf("got %+v", *cfg)
	}
}

func TestParseConfigOtherMachineMarksPasswordUnreadable(t *testing.T) {
	cfg, err := parseUnixConfig(readFixture(t, "config-linux"), func() string { return deriveKey("other-box", "tester") })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Password != "" || !cfg.PasswordUnreadable {
		t.Fatalf("password %q unreadable=%v, want empty and unreadable", cfg.Password, cfg.PasswordUnreadable)
	}
}

func TestParseLegacyBase64AndEmptyPassword(t *testing.T) {
	key := func() string { return "unused" }
	cfg, _ := parseUnixConfig(readFixture(t, "config-legacy-base64"), key)
	if cfg.Password != "Old-Pass-03" {
		t.Fatalf("legacy password = %q", cfg.Password)
	}
	cfg, _ = parseUnixConfig(readFixture(t, "config-empty-pass"), key)
	if cfg.Password != "" || cfg.PasswordUnreadable || cfg.NoAuth {
		t.Fatalf("empty-pass config = %+v", *cfg)
	}
}

func TestUnixConfigRoundTrip(t *testing.T) {
	key := deriveKey("h", "u")
	in := savedConfig{Mode: "native", LAN: true, Port: 7700, Tailscale: "a.ts.net", Mux: "herdr",
		AllowHosts: []string{"mybox.local", "proxy.lan"}, HerdrAllowNoAuth: true, Password: `p@ss w0rd$!`}
	data, err := formatUnixConfig(in, key)
	if err != nil {
		t.Fatal(err)
	}
	out, err := parseUnixConfig(data, func() string { return key })
	if err != nil {
		t.Fatal(err)
	}
	if out.Mode != in.Mode || out.LAN != in.LAN || out.Port != in.Port || out.Tailscale != in.Tailscale ||
		out.Mux != in.Mux || strings.Join(out.AllowHosts, ",") != "mybox.local,proxy.lan" ||
		!out.HerdrAllowNoAuth || out.Password != in.Password {
		t.Fatalf("round trip: got %+v, want %+v", *out, in)
	}
	// The 0.x keys stay first and keep their meaning.
	if !strings.HasPrefix(string(data), "# Termote config (auto-generated)\nTERMOTE_MODE=\"native\"\nTERMOTE_LAN=\"true\"\n") {
		t.Fatalf("unexpected layout:\n%s", data)
	}
}

// A config written by 1.0 must still open with the exact commands of 0.x, so
// a downgrade or 0.x get.sh keeps the saved password.
func TestGoEncryptedPasswordDecryptsWithZeroXOpenSSL(t *testing.T) {
	if _, err := exec.LookPath("openssl"); err != nil {
		t.Skip("openssl not installed")
	}
	key := deriveKey("termote-box", "tester")
	enc, err := encryptOpenSSL("Round-Trip-99", key)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("openssl", "enc", "-aes-256-cbc", "-a", "-A", "-d", "-salt", "-pbkdf2", "-pass", "pass:"+key)
	cmd.Stdin = strings.NewReader(enc + "\n") // 0.x pipes it through echo
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("openssl could not decrypt %q: %v", enc, err)
	}
	if string(out) != "Round-Trip-99" {
		t.Fatalf("openssl decrypted %q", out)
	}
}

func TestDecryptRejectsTamperedCiphertext(t *testing.T) {
	enc, _ := encryptOpenSSL("secret", "k")
	raw, _ := base64.StdEncoding.DecodeString(enc)
	raw[len(raw)-1] ^= 0xff
	if _, err := decryptSavedPassword(base64.StdEncoding.EncodeToString(raw), "k"); err == nil {
		t.Fatal("tampered ciphertext decrypted")
	}
	if _, err := decryptSavedPassword("not base64!", "k"); err == nil {
		t.Fatal("garbage decrypted")
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

func TestParseZeroXWindowsConfig(t *testing.T) {
	fakeDPAPI(t)
	cfg, err := parseWindowsConfig(readFixture(t, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Mode != "native" || !cfg.LAN || cfg.Port != 7690 || cfg.Tailscale != "win.tail1234.ts.net" || cfg.Password != "Win-Pass-04" {
		t.Fatalf("got %+v", *cfg)
	}
}

func TestWindowsConfigRoundTripDropsTtyd(t *testing.T) {
	fakeDPAPI(t)
	in := savedConfig{Mode: "container", Port: 7690, Mux: "tmux", AllowHosts: []string{"pc.lan"}, Password: "pw"}
	data, err := formatWindowsConfig(in, time.Date(2026, 9, 25, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "Ttyd") {
		t.Fatalf("Ttyd written:\n%s", data)
	}
	out, err := parseWindowsConfig(data)
	if err != nil {
		t.Fatal(err)
	}
	if out.Mode != "container" || out.Password != "pw" || out.Mux != "tmux" || strings.Join(out.AllowHosts, ",") != "pc.lan" {
		t.Fatalf("round trip got %+v", *out)
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
	if err := tc.saveConfig(savedConfig{Mode: "native", Port: 7680, Mux: "tmux", Password: "pw1"}); err != nil {
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
	tc.saveConfig(savedConfig{Mode: "native", Password: "Shown-01"})
	tc.stdout.Reset()
	if code := tc.main([]string{"show-password"}); code != 0 || !strings.Contains(tc.stdout.String(), "Password: Shown-01") {
		t.Fatalf("code %d out %q", code, tc.stdout.String())
	}
	tc.saveConfig(savedConfig{Mode: "native", NoAuth: true})
	tc.stdout.Reset()
	if code := tc.main([]string{"show-password"}); code != 0 || !strings.Contains(tc.stdout.String(), "disabled") {
		t.Fatalf("no-auth: code %d out %q", code, tc.stdout.String())
	}
}
