package main

import (
	"bufio"
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// savedConfig is what install persists and update re-applies. The file keeps
// the 0.x path and format so an upgrade reads it in place.
type savedConfig struct {
	Mode             string
	LAN              bool
	NoAuth           bool
	Port             int
	Tailscale        string
	Mux              string
	AllowHosts       []string // hosts added with --allow-host only
	HerdrAllowNoAuth bool
	Password         string // decrypted
	// PasswordUnreadable is set when a saved password exists but cannot be
	// decrypted (other machine or user); install then sets a new one.
	PasswordUnreadable bool
}

// loadConfig returns nil when no config was saved yet.
func (c *cli) loadConfig() (*savedConfig, error) {
	data, err := os.ReadFile(c.configFile())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if c.goos == "windows" {
		return parseWindowsConfig(data)
	}
	return parseUnixConfig(data, c.machineKey)
}

func (c *cli) saveConfig(cfg savedConfig) error {
	if err := os.MkdirAll(c.configDir(), 0o700); err != nil {
		return err
	}
	var data []byte
	var err error
	if c.goos == "windows" {
		data, err = formatWindowsConfig(cfg, time.Now())
	} else {
		data, err = formatUnixConfig(cfg, c.machineKey())
	}
	if err != nil {
		return err
	}
	// Write a temp file and rename it, so a crash never leaves a half
	// written config (and the saved password) behind.
	path := c.configFile()
	tmp := path + ".tmp"
	os.Remove(tmp)
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if c.goos == "windows" {
		if err := restrictToOwner(tmp); err != nil {
			c.warnf("Could not restrict config permissions: %v", err)
		}
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// Unix format: KEY="value" lines, parsed without sourcing, as 0.x did.
const (
	keyMode             = "TERMOTE_MODE"
	keyLAN              = "TERMOTE_LAN"
	keyNoAuth           = "TERMOTE_NO_AUTH"
	keyPort             = "TERMOTE_PORT"
	keyTailscale        = "TERMOTE_TAILSCALE"
	keySavedPass        = "TERMOTE_SAVED_PASS"
	keyMux              = "TERMOTE_MUX"
	keyAllowedHosts     = "TERMOTE_ALLOWED_HOSTS"
	keyHerdrAllowNoAuth = "TERMOTE_HERDR_ALLOW_NO_AUTH"
)

func parseUnixConfig(data []byte, key func() string) (*savedConfig, error) {
	kv := map[string]string{}
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		// 0.x read values with `tr -d '"'`.
		kv[k] = strings.ReplaceAll(v, `"`, "")
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	cfg := &savedConfig{
		Mode:             kv[keyMode],
		LAN:              kv[keyLAN] == "true",
		NoAuth:           kv[keyNoAuth] == "true",
		Tailscale:        kv[keyTailscale],
		Mux:              kv[keyMux],
		AllowHosts:       splitHosts(kv[keyAllowedHosts]),
		HerdrAllowNoAuth: kv[keyHerdrAllowNoAuth] == "true",
	}
	if p, err := strconv.Atoi(kv[keyPort]); err == nil {
		cfg.Port = p
	}
	if enc := kv[keySavedPass]; enc != "" {
		pass, err := decryptSavedPassword(enc, key())
		if err != nil {
			cfg.PasswordUnreadable = true
		} else {
			cfg.Password = pass
		}
	}
	return cfg, nil
}

func formatUnixConfig(cfg savedConfig, key string) ([]byte, error) {
	enc := ""
	if cfg.Password != "" {
		var err error
		if enc, err = encryptOpenSSL(cfg.Password, key); err != nil {
			return nil, err
		}
	}
	for _, v := range []string{cfg.Mode, cfg.Tailscale, cfg.Mux, strings.Join(cfg.AllowHosts, ",")} {
		if strings.ContainsAny(v, "\"\n\r") {
			return nil, fmt.Errorf("invalid config value %q", v)
		}
	}
	var b strings.Builder
	w := func(k, v string) { fmt.Fprintf(&b, "%s=\"%s\"\n", k, v) }
	b.WriteString("# Termote config (auto-generated)\n")
	w(keyMode, cfg.Mode)
	w(keyLAN, strconv.FormatBool(cfg.LAN))
	w(keyNoAuth, strconv.FormatBool(cfg.NoAuth))
	w(keyPort, strconv.Itoa(cfg.Port))
	w(keyTailscale, cfg.Tailscale)
	w(keySavedPass, enc)
	w(keyMux, cfg.Mux)
	w(keyAllowedHosts, strings.Join(cfg.AllowHosts, ","))
	w(keyHerdrAllowNoAuth, strconv.FormatBool(cfg.HerdrAllowNoAuth))
	return []byte(b.String()), nil
}

// windowsConfigFile mirrors the ConvertTo-Json output of 0.x termote.ps1. The
// 0.x Ttyd key is read and dropped.
type windowsConfigFile struct {
	Mode             string   `json:"Mode"`
	Lan              bool     `json:"Lan"`
	NoAuth           bool     `json:"NoAuth"`
	Port             int      `json:"Port"`
	Tailscale        string   `json:"Tailscale"`
	EncryptedPass    string   `json:"EncryptedPass"`
	Mux              string   `json:"Mux,omitempty"`
	AllowHost        []string `json:"AllowHost,omitempty"`
	HerdrAllowNoAuth bool     `json:"HerdrAllowNoAuth,omitempty"`
	SavedAt          string   `json:"SavedAt"`
}

// dpapiProtect and dpapiUnprotect encrypt for the current Windows user; they
// are variables so tests on any OS can exercise the Windows format.
var (
	dpapiProtect   = protectCurrentUser
	dpapiUnprotect = unprotectCurrentUser
)

func parseWindowsConfig(data []byte) (*savedConfig, error) {
	// Windows PowerShell 5.1 writes UTF-8 with a BOM.
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	var f windowsConfigFile
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	cfg := &savedConfig{
		Mode:             f.Mode,
		LAN:              f.Lan,
		NoAuth:           f.NoAuth,
		Port:             f.Port,
		Tailscale:        f.Tailscale,
		Mux:              f.Mux,
		AllowHosts:       f.AllowHost,
		HerdrAllowNoAuth: f.HerdrAllowNoAuth,
	}
	if f.EncryptedPass != "" {
		blob, err := base64.StdEncoding.DecodeString(f.EncryptedPass)
		var plain []byte
		if err == nil {
			plain, err = dpapiUnprotect(blob)
		}
		if err != nil {
			cfg.PasswordUnreadable = true
		} else {
			cfg.Password = string(plain)
		}
	}
	return cfg, nil
}

func formatWindowsConfig(cfg savedConfig, now time.Time) ([]byte, error) {
	f := windowsConfigFile{
		Mode:             cfg.Mode,
		Lan:              cfg.LAN,
		NoAuth:           cfg.NoAuth,
		Port:             cfg.Port,
		Tailscale:        cfg.Tailscale,
		Mux:              cfg.Mux,
		AllowHost:        cfg.AllowHosts,
		HerdrAllowNoAuth: cfg.HerdrAllowNoAuth,
		SavedAt:          now.Format(time.RFC3339),
	}
	if cfg.Password != "" {
		blob, err := dpapiProtect([]byte(cfg.Password))
		if err != nil {
			return nil, fmt.Errorf("encrypt password: %w", err)
		}
		f.EncryptedPass = base64.StdEncoding.EncodeToString(blob)
	}
	return json.MarshalIndent(f, "", "    ")
}

// machineKey is the 0.x passphrase: sha256 hex of "<hostname>-<username>-termote",
// where hostname and username come from the `hostname` and `whoami` commands
// (their output can differ from the Go APIs, e.g. on macOS).
func (c *cli) machineKey() string {
	host := c.commandLine("hostname")
	if host == "" {
		host, _ = os.Hostname()
	}
	name := c.commandLine("whoami")
	if name == "" {
		if u, err := user.Current(); err == nil {
			name = u.Username
		}
	}
	return deriveKey(host, name)
}

func deriveKey(host, name string) string {
	sum := sha256.Sum256([]byte(host + "-" + name + "-termote"))
	return hex.EncodeToString(sum[:])
}

// commandLine returns the first output line of a command, or "".
func (c *cli) commandLine(name string, args ...string) string {
	out, err := c.run.Output("", nil, name, args...)
	if err != nil {
		return ""
	}
	line, _, _ := strings.Cut(string(out), "\n")
	return strings.TrimSpace(line)
}

// OpenSSL `enc -aes-256-cbc -a -A -salt -pbkdf2` format: base64 of
// "Salted__" + 8-byte salt + ciphertext; key and IV are PBKDF2-HMAC-SHA256
// with 10000 iterations.
const (
	opensslMagic = "Salted__"
	opensslIter  = 10000
)

func opensslKeyIV(pass string, salt []byte) (key, iv []byte, err error) {
	dk, err := pbkdf2.Key(sha256.New, pass, salt, opensslIter, 32+aes.BlockSize)
	if err != nil {
		return nil, nil, err
	}
	return dk[:32], dk[32:], nil
}

func encryptOpenSSL(plain, pass string) (string, error) {
	salt := make([]byte, 8)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, iv, err := opensslKeyIV(pass, salt)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	pad := aes.BlockSize - len(plain)%aes.BlockSize
	buf := append([]byte(plain), bytes.Repeat([]byte{byte(pad)}, pad)...)
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(buf, buf)
	out := append(append([]byte(opensslMagic), salt...), buf...)
	return base64.StdEncoding.EncodeToString(out), nil
}

var errBadCiphertext = errors.New("cannot decrypt saved password")

func decryptOpenSSL(data []byte, pass string) (string, error) {
	if len(data) < 16+aes.BlockSize || string(data[:8]) != opensslMagic || (len(data)-16)%aes.BlockSize != 0 {
		return "", errBadCiphertext
	}
	key, iv, err := opensslKeyIV(pass, data[8:16])
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	buf := append([]byte(nil), data[16:]...)
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(buf, buf)
	pad := int(buf[len(buf)-1])
	if pad < 1 || pad > aes.BlockSize || !bytes.Equal(buf[len(buf)-pad:], bytes.Repeat([]byte{byte(pad)}, pad)) {
		return "", errBadCiphertext
	}
	return string(buf[:len(buf)-pad]), nil
}

// decryptSavedPassword reads TERMOTE_SAVED_PASS: the openssl format, or the
// plain base64 an early 0.0.x wrote.
func decryptSavedPassword(enc, key string) (string, error) {
	data, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return "", errBadCiphertext
	}
	if !bytes.HasPrefix(data, []byte(opensslMagic)) {
		return string(data), nil
	}
	return decryptOpenSSL(data, key)
}

// generatePassword returns 12 random alphanumerics, like 0.x.
func generatePassword() (string, error) {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	for i := range b {
		// 256 % 62 bias is negligible for a 12-char password.
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b), nil
}

// hostNameRe accepts DNS names and IPv4/IPv6 literals, nothing that could
// break the config line or the comma-separated env var.
var hostNameRe = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9.\-:]*[A-Za-z0-9])?$`)

func validateHostName(h string) error {
	if h == "*" {
		return errors.New("--allow-host does not accept *: the Host check cannot be switched off, add each name instead")
	}
	if !hostNameRe.MatchString(h) {
		return fmt.Errorf("invalid host name %q", h)
	}
	return nil
}

func splitHosts(s string) []string {
	var out []string
	for _, h := range strings.Split(s, ",") {
		if h = strings.TrimSpace(h); h != "" {
			out = append(out, h)
		}
	}
	return out
}

// removeFile deletes path, ignoring a missing file.
func removeFile(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// ensureDir creates dir and its parents.
func ensureDir(dir string) error { return os.MkdirAll(filepath.Clean(dir), 0o755) }
