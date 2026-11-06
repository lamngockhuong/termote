package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Every ssh termote runs for a machine is OpenSSH's own client with argv
// built here: the destination always follows "--", and no option ever comes
// from data (the alias is checked by validAlias, the paths are termote's).
// The options below override whatever the alias's ~/.ssh/config block says
// (the command line wins over the config file): no forwarding, no agent, no
// local or remote command, no TTY, no master the user's config would share.

// sshPaths are termote's own SSH files: its key and its known_hosts.
type sshPaths struct {
	Key        string
	KnownHosts string
}

// sshOptValue quotes a path for an -o option, which ssh splits on spaces.
func sshOptValue(p string) string {
	return `"` + strings.ReplaceAll(p, `\`, `/`) + `"`
}

// sshHardenOpts are the options every machine ssh takes: what the alias's
// config block may switch on, switched off, and the host key looked up under
// the machine's own name in termote's known_hosts.
func sshHardenOpts(kh, id string) []string {
	return []string{
		"-o", "UserKnownHostsFile=" + sshOptValue(kh),
		"-o", "HostKeyAlias=termote-" + id,
		"-o", "CheckHostIP=no",
		"-o", "UpdateHostKeys=no",
		"-o", "ClearAllForwardings=yes",
		"-o", "ForwardAgent=no",
		"-o", "ForwardX11=no",
		"-o", "PermitLocalCommand=no",
		"-o", "RemoteCommand=none",
		"-o", "RequestTTY=no",
		"-o", "Tunnel=no",
		"-o", "ControlMaster=no",
		"-o", "ControlPath=none",
	}
}

// sshServiceOpts are the options of the ssh the server runs: no prompt, a
// host key it already knows, termote's key only.
func sshServiceOpts(p sshPaths, id string) []string {
	return append([]string{
		"-o", "BatchMode=yes",
		"-o", "StrictHostKeyChecking=yes",
		"-o", "IdentitiesOnly=yes",
		"-o", "IdentityAgent=none",
		"-i", p.Key,
		"-o", "ConnectTimeout=10",
		"-o", "ServerAliveInterval=15",
		"-o", "ServerAliveCountMax=3",
	}, sshHardenOpts(p.KnownHosts, id)...)
}

// sshBridgeArgv is one bridge connection: through the master at ctl when
// there is one, else a connection of its own. The command is ignored by the
// key's forced command; it is written so `ps` reads well.
func sshBridgeArgv(p sshPaths, m machineRecord, ctl string) []string {
	argv := []string{"ssh"}
	if ctl != "" {
		argv = append(argv, "-S", ctl)
	}
	argv = append(argv, sshServiceOpts(p, m.ID)...)
	return append(argv, "--", m.Alias, "bridge")
}

// sshMasterArgv is the master of a machine at ctl: no command, no
// ControlPersist (it would leave the server's sight), killed with it.
func sshMasterArgv(p sshPaths, m machineRecord, ctl string) []string {
	argv := []string{"ssh", "-M", "-N", "-S", ctl, "-o", "ControlPersist=no"}
	argv = append(argv, sshServiceOpts(p, m.ID)...)
	return append(argv, "--", m.Alias)
}

// sshMasterExitArgv asks a master left at ctl to exit.
func sshMasterExitArgv(p sshPaths, m machineRecord, ctl string) []string {
	argv := []string{"ssh", "-S", ctl, "-O", "exit"}
	argv = append(argv, sshServiceOpts(p, m.ID)...)
	return append(argv, "--", m.Alias)
}

// sshUserArgv is an ssh of the user's own, at the terminal, for adding and
// removing a machine: their keys and agent, OpenSSH asking about a host key
// it does not know (saved in termote's known_hosts), and command run there.
func sshUserArgv(kh string, m machineRecord, command string) []string {
	argv := []string{"ssh", "-o", "StrictHostKeyChecking=ask"}
	argv = append(argv, sshHardenOpts(kh, m.ID)...)
	return append(argv, "--", m.Alias, command)
}

// sshKeygenArgv makes termote's key, without a passphrase (the service runs
// unattended).
func sshKeygenArgv(key, comment string) []string {
	return []string{"ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", key}
}

// sshForgetHostArgv removes a machine's host key from termote's known_hosts.
func sshForgetHostArgv(kh, id string) []string {
	return []string{"ssh-keygen", "-R", "termote-" + id, "-f", kh}
}

// whereamiScript finds termote on a Unix machine, even when the shell ssh
// runs there reads no profile, and asks it where it lives.
const whereamiScript = `sh -c 'PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin"; ` +
	`t=$(command -v termote) || { echo TERMOTE-NOT-FOUND; exit 3; }; exec "$t" machine whereami'`

// installKeyScript appends the line on its stdin to ~/.ssh/authorized_keys,
// once; a new dir and file get 0700 and 0600.
const installKeyScript = `sh -c 'umask 077; f="$HOME/.ssh/authorized_keys"; mkdir -p "$HOME/.ssh" && touch "$f" && line=$(cat) && ` +
	`{ grep -qxF "$line" "$f" || { [ ! -s "$f" ] || tail -c1 "$f" | read -r _ || echo >> "$f"; printf "%s\n" "$line" >> "$f"; }; }'`

// removeKeyScript drops every line of ~/.ssh/authorized_keys holding the key
// on its stdin, keeping the file's mode. The file is rewritten only once the
// copy without those lines is whole (grep exits 0, or 1 when no line is
// left): a copy cut short (a full disk) never replaces it, so no other key
// is lost.
const removeKeyScript = `sh -c 'f="$HOME/.ssh/authorized_keys"; t="$f.termote"; key=$(cat); [ -n "$key" ] && [ -f "$f" ] || exit 0; ` +
	`umask 077; grep -vF "$key" "$f" > "$t"; rc=$?; if [ "$rc" -le 1 ] && [ -f "$t" ]; then cat "$t" > "$f" || exit 1; fi; rm -f "$t"; [ "$rc" -le 1 ]'`

// whereami is what `termote machine whereami` prints: where termote runs on a
// machine, for the forced command of its key.
type whereami struct {
	Exe        string `json:"exe"`
	SocketDir  string `json:"socketDir,omitempty"`
	OS         string `json:"os"`
	Version    string `json:"version"`
	APIVersion int    `json:"apiVersion"`
	Native     bool   `json:"native"`
}

var winAbsRe = regexp.MustCompile(`^[A-Za-z]:/`)

// validRemotePath checks a path of the machine (goos: its OS) goes into the
// forced command unchanged: absolute, and nothing a shell or the
// authorized_keys format reads (quotes, backslash, $, `, newline, control
// characters). A Windows path is written with '/'.
func validRemotePath(p, goos string) error {
	if goos == "windows" {
		if !winAbsRe.MatchString(p) {
			return fmt.Errorf("%q is not an absolute path", p)
		}
	} else if !strings.HasPrefix(p, "/") {
		return fmt.Errorf("%q is not an absolute path", p)
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f || strings.ContainsRune("\"'\\$`", r) {
			return fmt.Errorf("%q holds a character the forced command cannot take", p)
		}
	}
	return nil
}

// parseWhereami reads whereami's output: the last line, as JSON.
func parseWhereami(out []byte) (whereami, error) {
	s := strings.TrimSpace(string(out))
	if strings.Contains(s, "TERMOTE-NOT-FOUND") {
		return whereami{}, errors.New("termote was not found on the machine: install it there first (https://termote.ohnice.app)")
	}
	if i := strings.LastIndexByte(s, '\n'); i >= 0 {
		s = s[i+1:]
	}
	var w whereami
	if err := json.Unmarshal([]byte(s), &w); err != nil || w.Exe == "" {
		return whereami{}, errors.New("the machine's termote did not say where it lives (too old? update it there)")
	}
	if w.OS == "windows" {
		w.Exe = strings.ReplaceAll(w.Exe, `\`, "/")
		w.SocketDir = ""
	}
	if err := validRemotePath(w.Exe, w.OS); err != nil {
		return whereami{}, err
	}
	if w.SocketDir != "" {
		if err := validRemotePath(w.SocketDir, w.OS); err != nil {
			return whereami{}, err
		}
	}
	return w, nil
}

// forcedCommand is the command the machine's key may run: its termote's
// bridge, the socket dir fixed (sshd's environment may differ from the
// service's). Paths were checked by validRemotePath.
func forcedCommand(m machineRecord) string {
	if m.RemoteOS == "windows" {
		return `\"` + m.RemoteExe + `\" bridge`
	}
	cmd := "'" + m.RemoteExe + "' bridge"
	if m.SocketDir != "" {
		cmd += " --socket-dir '" + m.SocketDir + "'"
	}
	return cmd
}

// authorizedKeyLine is the line installed on the machine: the forced
// command, restrict (no PTY, no forwarding of any kind), the public key.
func authorizedKeyLine(m machineRecord, pub string) string {
	return `command="` + forcedCommand(m) + `",restrict ` + strings.TrimSpace(pub)
}

// publicKeyBlob is the base64 field of a public key line.
func publicKeyBlob(pub string) string {
	f := strings.Fields(pub)
	if len(f) < 2 {
		return ""
	}
	return f[1]
}
