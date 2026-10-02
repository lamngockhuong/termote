package main

import (
	"bufio"
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// savedConfig is what start saves and serve, restart and update read. The
// native server's settings come first; the container keeps its own, and the
// password is shared by both.
type savedConfig struct {
	LAN              bool
	NoAuth           bool
	Port             int
	Tailscale        string
	Mux              string
	AllowHosts       []string // hosts added with --allow-host only
	HerdrAllowNoAuth bool
	// User is the Basic auth username, shared by native and container like
	// the password; "" (a config saved before it existed) means admin.
	User     string
	Password string // decrypted
	// PasswordUnreadable is set when a saved password exists but cannot be
	// decrypted (the secret file is gone, or another user); start then sets
	// a new one.
	PasswordUnreadable bool
	// Container holds `termote container up`'s settings; nil until used.
	Container *containerConfig
}

// containerConfig is the container's part of the config.
type containerConfig struct {
	LAN        bool
	NoAuth     bool
	Port       int
	Tailscale  string
	AllowHosts []string
	Workspace  string
	// Mux is the backend inside the container, apart from the native one;
	// "" until the first up picks one.
	Mux              string
	HerdrAllowNoAuth bool
}

// savedContainer keeps the container's settings when the native ones are
// saved.
func (c *cli) savedContainer(saved *savedConfig) *containerConfig {
	if saved == nil {
		return nil
	}
	return saved.Container
}

// authUser is the Basic auth username: the saved one, else admin.
func (s *savedConfig) authUser() string {
	if s == nil || s.User == "" {
		return adminUser
	}
	return s.User
}

// keptPassword is the password to save: the new one, or with auth off (an
// empty one) the saved one, which the other of native and container shares.
func (c *cli) keptPassword(pass string, saved *savedConfig) string {
	if pass == "" && saved != nil {
		return saved.Password
	}
	return pass
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
	return parseUnixConfig(data, c.readSecret)
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
		var key string
		if key, err = c.ensureSecret(); err != nil {
			return err
		}
		data, err = formatUnixConfig(cfg, key)
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

// secretFile holds the key the saved password is encrypted with on Unix: 32
// random bytes, hex, readable by the owner only. The password is therefore
// protected by file permissions; the secret only keeps it out of plain text
// in the config (and out of backups that copy the config alone).
func (c *cli) secretFile() string { return filepath.Join(c.configDir(), "secret") }

// readSecret returns the key, or "" when there is none (decryption then
// fails and the password counts as unreadable).
func (c *cli) readSecret() string {
	b, err := os.ReadFile(c.secretFile())
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// ensureSecret returns the key, creating it on first use.
func (c *cli) ensureSecret() (string, error) {
	if k := c.readSecret(); len(k) == 64 {
		return k, nil
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	k := hex.EncodeToString(b)
	if err := os.MkdirAll(c.configDir(), 0o700); err != nil {
		return "", err
	}
	tmp := c.secretFile() + ".tmp"
	os.Remove(tmp)
	if err := os.WriteFile(tmp, []byte(k+"\n"), 0o600); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, c.secretFile()); err != nil {
		os.Remove(tmp)
		return "", err
	}
	return k, nil
}

// Unix format: KEY="value" lines, parsed without sourcing.
const (
	keyLAN              = "TERMOTE_LAN"
	keyNoAuth           = "TERMOTE_NO_AUTH"
	keyPort             = "TERMOTE_PORT"
	keyTailscale        = "TERMOTE_TAILSCALE"
	keySavedPass        = "TERMOTE_SAVED_PASS"
	keySavedPassMAC     = "TERMOTE_SAVED_PASS_MAC"
	keyMux              = "TERMOTE_MUX"
	keyAllowedHosts     = "TERMOTE_ALLOWED_HOSTS"
	keyHerdrAllowNoAuth = "TERMOTE_HERDR_ALLOW_NO_AUTH"
	keyUser             = "TERMOTE_USER"

	// The container's keys; present once `container up` ran.
	keyContainerLAN         = "TERMOTE_CONTAINER_LAN"
	keyContainerNoAuth      = "TERMOTE_CONTAINER_NO_AUTH"
	keyContainerPort        = "TERMOTE_CONTAINER_PORT"
	keyContainerTailscale   = "TERMOTE_CONTAINER_TAILSCALE"
	keyContainerHosts       = "TERMOTE_CONTAINER_ALLOWED_HOSTS"
	keyContainerWorkspace   = "TERMOTE_CONTAINER_WORKSPACE"
	keyContainerMux         = "TERMOTE_CONTAINER_MUX"
	keyContainerHerdrNoAuth = "TERMOTE_CONTAINER_HERDR_ALLOW_NO_AUTH"
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
		// Quotes are dropped, never interpreted.
		kv[k] = strings.ReplaceAll(v, `"`, "")
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	cfg := &savedConfig{
		LAN:              kv[keyLAN] == "true",
		NoAuth:           kv[keyNoAuth] == "true",
		Tailscale:        kv[keyTailscale],
		Mux:              kv[keyMux],
		AllowHosts:       splitHosts(kv[keyAllowedHosts]),
		HerdrAllowNoAuth: kv[keyHerdrAllowNoAuth] == "true",
		User:             kv[keyUser],
	}
	cfg.Port, _ = strconv.Atoi(kv[keyPort])
	if _, ok := kv[keyContainerPort]; ok {
		cc := &containerConfig{
			LAN:              kv[keyContainerLAN] == "true",
			NoAuth:           kv[keyContainerNoAuth] == "true",
			Tailscale:        kv[keyContainerTailscale],
			AllowHosts:       splitHosts(kv[keyContainerHosts]),
			Workspace:        kv[keyContainerWorkspace],
			Mux:              kv[keyContainerMux],
			HerdrAllowNoAuth: kv[keyContainerHerdrNoAuth] == "true",
		}
		cc.Port, _ = strconv.Atoi(kv[keyContainerPort])
		cfg.Container = cc
	}
	if enc := kv[keySavedPass]; enc != "" {
		pass, err := decryptSavedPassword(enc, kv[keySavedPassMAC], key())
		if err != nil {
			cfg.PasswordUnreadable = true
		} else {
			cfg.Password = pass
		}
	}
	return cfg, nil
}

func formatUnixConfig(cfg savedConfig, key string) ([]byte, error) {
	enc, mac := "", ""
	if cfg.Password != "" {
		var err error
		if enc, err = encryptOpenSSL(cfg.Password, key); err != nil {
			return nil, err
		}
		mac = passwordMAC(enc, key)
	}
	values := []string{cfg.Tailscale, cfg.Mux, strings.Join(cfg.AllowHosts, ","), cfg.User}
	if cc := cfg.Container; cc != nil {
		values = append(values, cc.Tailscale, strings.Join(cc.AllowHosts, ","), cc.Workspace, cc.Mux)
	}
	for _, v := range values {
		if strings.ContainsAny(v, "\"\n\r") {
			return nil, fmt.Errorf("invalid config value %q", v)
		}
	}
	var b strings.Builder
	w := func(k, v string) { fmt.Fprintf(&b, "%s=\"%s\"\n", k, v) }
	b.WriteString("# Termote config (written by termote start)\n")
	w(keyLAN, strconv.FormatBool(cfg.LAN))
	w(keyNoAuth, strconv.FormatBool(cfg.NoAuth))
	w(keyPort, strconv.Itoa(cfg.Port))
	w(keyTailscale, cfg.Tailscale)
	w(keySavedPass, enc)
	w(keySavedPassMAC, mac)
	w(keyMux, cfg.Mux)
	w(keyAllowedHosts, strings.Join(cfg.AllowHosts, ","))
	w(keyHerdrAllowNoAuth, strconv.FormatBool(cfg.HerdrAllowNoAuth))
	w(keyUser, cfg.User)
	if cc := cfg.Container; cc != nil {
		w(keyContainerLAN, strconv.FormatBool(cc.LAN))
		w(keyContainerNoAuth, strconv.FormatBool(cc.NoAuth))
		w(keyContainerPort, strconv.Itoa(cc.Port))
		w(keyContainerTailscale, cc.Tailscale)
		w(keyContainerHosts, strings.Join(cc.AllowHosts, ","))
		w(keyContainerWorkspace, cc.Workspace)
		w(keyContainerMux, cc.Mux)
		w(keyContainerHerdrNoAuth, strconv.FormatBool(cc.HerdrAllowNoAuth))
	}
	return []byte(b.String()), nil
}

// windowsConfigFile is the JSON config on Windows; the password is DPAPI
// encrypted for the current user.
type windowsConfigFile struct {
	Lan              bool                 `json:"Lan"`
	NoAuth           bool                 `json:"NoAuth"`
	Port             int                  `json:"Port"`
	Tailscale        string               `json:"Tailscale"`
	EncryptedPass    string               `json:"EncryptedPass"`
	Mux              string               `json:"Mux,omitempty"`
	AllowHost        []string             `json:"AllowHost,omitempty"`
	HerdrAllowNoAuth bool                 `json:"HerdrAllowNoAuth,omitempty"`
	User             string               `json:"User,omitempty"`
	Container        *windowsContainerCfg `json:"Container,omitempty"`
	SavedAt          string               `json:"SavedAt"`
}

type windowsContainerCfg struct {
	Lan              bool     `json:"Lan"`
	NoAuth           bool     `json:"NoAuth"`
	Port             int      `json:"Port"`
	Tailscale        string   `json:"Tailscale,omitempty"`
	AllowHost        []string `json:"AllowHost,omitempty"`
	Workspace        string   `json:"Workspace,omitempty"`
	Mux              string   `json:"Mux,omitempty"`
	HerdrAllowNoAuth bool     `json:"HerdrAllowNoAuth,omitempty"`
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
		LAN:              f.Lan,
		NoAuth:           f.NoAuth,
		Port:             f.Port,
		Tailscale:        f.Tailscale,
		Mux:              f.Mux,
		AllowHosts:       f.AllowHost,
		HerdrAllowNoAuth: f.HerdrAllowNoAuth,
		User:             f.User,
	}
	if cc := f.Container; cc != nil {
		cfg.Container = &containerConfig{LAN: cc.Lan, NoAuth: cc.NoAuth, Port: cc.Port, Tailscale: cc.Tailscale, AllowHosts: cc.AllowHost, Workspace: cc.Workspace,
			Mux: cc.Mux, HerdrAllowNoAuth: cc.HerdrAllowNoAuth}
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
		Lan:              cfg.LAN,
		NoAuth:           cfg.NoAuth,
		Port:             cfg.Port,
		Tailscale:        cfg.Tailscale,
		Mux:              cfg.Mux,
		AllowHost:        cfg.AllowHosts,
		HerdrAllowNoAuth: cfg.HerdrAllowNoAuth,
		User:             cfg.User,
		SavedAt:          now.Format(time.RFC3339),
	}
	if cc := cfg.Container; cc != nil {
		f.Container = &windowsContainerCfg{Lan: cc.LAN, NoAuth: cc.NoAuth, Port: cc.Port, Tailscale: cc.Tailscale, AllowHost: cc.AllowHosts, Workspace: cc.Workspace,
			Mux: cc.Mux, HerdrAllowNoAuth: cc.HerdrAllowNoAuth}
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

// passwordMAC authenticates the encrypted password with the key: CBC alone
// only checks padding, so a wrong or missing key would "decrypt" to garbage
// about once in 200 tries instead of failing.
func passwordMAC(enc, key string) string {
	m := hmac.New(sha256.New, []byte(key))
	m.Write([]byte("termote-saved-pass\x00" + enc))
	return hex.EncodeToString(m.Sum(nil))
}

// decryptSavedPassword reads TERMOTE_SAVED_PASS (the openssl format) after
// checking its MAC. Without a key, or with a MAC that does not match, the
// password is unreadable.
func decryptSavedPassword(enc, mac, key string) (string, error) {
	if key == "" {
		return "", errBadCiphertext
	}
	if !hmac.Equal([]byte(strings.ToLower(mac)), []byte(passwordMAC(enc, key))) {
		return "", errBadCiphertext
	}
	data, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return "", errBadCiphertext
	}
	return decryptOpenSSL(data, key)
}

// generatePassword returns 12 random alphanumerics.
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

// userNameRe is a Basic auth username --user accepts: no ":" (it separates
// the name from the password), nothing that could break the config line or
// an environment variable.
var userNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$`)

func validateUserName(u string) error {
	if !userNameRe.MatchString(u) {
		return fmt.Errorf("invalid --user %q: use 1 to 64 letters, digits, '.', '_', '-' or '@', starting with a letter or digit", u)
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
