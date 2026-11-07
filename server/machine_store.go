package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"
)

// The machines another termote reaches over SSH (`termote machine add`) are
// kept in machines.json beside the config, 0600: the config's key="value"
// lines hold no nested records. Only the CLI writes it; the server reads it
// at start and on machines/reload. Neither the alias nor the paths ever
// leave the server: the API and the snapshot carry {id, label, status}.

// maxMachines bounds the store: each machine is an SSH master and a poll.
const maxMachines = 32

// machineRecord is one machine: Alias is the ssh destination (a Host of
// ~/.ssh/config or a host name, never an option), RemoteExe the termote
// its key's forced command runs and SocketDir that termote's socket dir
// ("" for a Windows machine, whose bridge is a pipe).
type machineRecord struct {
	ID        string    `json:"id"`
	Label     string    `json:"label"`
	Alias     string    `json:"alias"`
	RemoteExe string    `json:"remoteExe"`
	SocketDir string    `json:"socketDir,omitempty"`
	RemoteOS  string    `json:"remoteOS,omitempty"`
	AddedAt   time.Time `json:"addedAt"`
}

type machineFile struct {
	Machines []machineRecord `json:"machines"`
}

// aliasRe is what an alias may be: it starts with a letter or digit, so ssh
// never reads it as an option, and holds no space, '@' or ':'
// (user@host:port belongs in ~/.ssh/config).
var aliasRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// machineIDRe is a machine id: 16 hex digits.
var machineIDRe = regexp.MustCompile(`^[0-9a-f]{16}$`)

func validAlias(a string) error {
	if !aliasRe.MatchString(a) {
		return fmt.Errorf("invalid alias %q: use a Host of ~/.ssh/config or a host name (letters, digits, '.', '_', '-', at most 64)", a)
	}
	return nil
}

func validLabel(l string) error {
	if l == "" || len(l) > 64 || strings.TrimSpace(l) != l {
		return fmt.Errorf("invalid label %q: 1 to 64 characters, no leading or trailing space", l)
	}
	for _, r := range l {
		if !unicode.IsPrint(r) {
			return fmt.Errorf("invalid label %q: printable characters only", l)
		}
	}
	return nil
}

// newMachineID is 8 random bytes in hex.
func newMachineID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// loadMachines reads the store at path: none when it does not exist. A
// record that fails the checks fails the whole read, so a hand-edited alias
// never reaches ssh's argv.
func loadMachines(path string) ([]machineRecord, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var f machineFile
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if len(f.Machines) > maxMachines {
		return nil, fmt.Errorf("%s: more than %d machines", path, maxMachines)
	}
	seen := map[string]bool{}
	for _, m := range f.Machines {
		if err := checkMachineRecord(m); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		for _, k := range []string{"id:" + m.ID, "alias:" + m.Alias, "label:" + m.Label} {
			if seen[k] {
				return nil, fmt.Errorf("%s: duplicate %s", path, k)
			}
			seen[k] = true
		}
	}
	return f.Machines, nil
}

func checkMachineRecord(m machineRecord) error {
	if !machineIDRe.MatchString(m.ID) {
		return fmt.Errorf("invalid machine id %q", m.ID)
	}
	if err := validAlias(m.Alias); err != nil {
		return err
	}
	if err := validLabel(m.Label); err != nil {
		return err
	}
	if err := validRemotePath(m.RemoteExe, m.RemoteOS); err != nil {
		return fmt.Errorf("remote termote: %w", err)
	}
	if m.SocketDir != "" {
		if err := validRemotePath(m.SocketDir, m.RemoteOS); err != nil {
			return fmt.Errorf("remote socket dir: %w", err)
		}
	}
	return nil
}

// saveMachines writes the store at path (0600, its dir 0700) through a temp
// file renamed over it.
func saveMachines(path string, list []machineRecord) error {
	if len(list) > maxMachines {
		return fmt.Errorf("at most %d machines", maxMachines)
	}
	if list == nil {
		list = []machineRecord{}
	}
	data, err := json.MarshalIndent(machineFile{Machines: list}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".machines-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// findMachine returns the index of the machine whose id or label is key,
// or -1.
func findMachine(list []machineRecord, key string) int {
	for i, m := range list {
		if m.ID == key || m.Label == key {
			return i
		}
	}
	return -1
}
