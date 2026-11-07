package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"text/tabwriter"
	"time"
)

// `termote machine` adds the machines this termote reaches over SSH, lists,
// checks and removes them. Only this CLI changes the list: the PWA picks a
// machine by its id and never sees its alias. See machine_store.go.

func (c *cli) machinesFile() string { return filepath.Join(c.configDir(), "machines.json") }

// machineSSHDir holds termote's own key and known_hosts, under the config
// dir that uninstall --purge removes.
func (c *cli) machineSSHDir() string { return filepath.Join(c.configDir(), "ssh") }

func (c *cli) machineSSHPaths() sshPaths {
	return sshPaths{
		Key:        filepath.Join(c.machineSSHDir(), "id_ed25519"),
		KnownHosts: filepath.Join(c.machineSSHDir(), "known_hosts"),
	}
}

// interact runs argv at the user's terminal (Interact).
func (c *cli) interact(input string, argv []string) ([]byte, error) {
	return c.run.Interact(input, argv[0], argv[1:]...)
}

func (c *cli) cmdMachine(args []string) error {
	if len(args) == 0 {
		return c.machineList(nil)
	}
	switch args[0] {
	case "add":
		return c.machineAdd(args[1:])
	case "list", "ls":
		return c.machineList(args[1:])
	case "remove", "rm":
		return c.machineRemove(args[1:])
	case "status":
		return c.machineStatusCmd(args[1:])
	case "import":
		return c.machineImport(args[1:])
	case "whereami":
		return c.machineWhereami()
	}
	return usageError("unknown machine command: %s (use: add, list, remove, status, import --herdr)", args[0])
}

// machineAddOpts are the flags of machine add.
type machineAddOpts struct {
	label, remoteExe, remoteSocketDir string
	printKey, noCheck, yes            bool
}

func (c *cli) machineAdd(args []string) error {
	var o machineAddOpts
	fs := c.newFlagSet("machine add")
	fs.StringVar(&o.label, "label", "", "")
	fs.StringVar(&o.remoteExe, "remote-exe", "", "")
	fs.StringVar(&o.remoteSocketDir, "remote-socket-dir", "", "")
	fs.BoolVar(&o.printKey, "print-key", false, "")
	fs.BoolVar(&o.noCheck, "no-check", false, "")
	fs.BoolVar(&o.yes, "yes", false, "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	if len(pos) != 1 {
		return usageError("usage: termote machine add <ssh alias> [--label <name>] [--print-key] [--no-check]")
	}
	return c.addMachine(pos[0], o)
}

func (c *cli) addMachine(alias string, o machineAddOpts) error {
	if err := validAlias(alias); err != nil {
		return usageError("%v", err)
	}
	if o.label == "" {
		o.label = alias
	}
	if err := validLabel(o.label); err != nil {
		return usageError("%v", err)
	}
	list, err := loadMachines(c.machinesFile())
	if err != nil {
		return err
	}
	for _, m := range list {
		if m.Alias == alias || m.Label == o.label {
			return fmt.Errorf("a machine named %q is already added (remove it first: termote machine remove %s)", o.label, m.Label)
		}
	}
	if len(list) >= maxMachines {
		return fmt.Errorf("at most %d machines can be added", maxMachines)
	}
	for _, tool := range []string{"ssh", "ssh-keygen"} {
		if _, err := c.run.LookPath(tool); err != nil {
			return fmt.Errorf("%s was not found: install the OpenSSH client", tool)
		}
	}
	pub, err := c.ensureMachineKey()
	if err != nil {
		return err
	}
	id, err := newMachineID()
	if err != nil {
		return err
	}
	rec := machineRecord{ID: id, Label: o.label, Alias: alias, AddedAt: time.Now().UTC()}
	paths := c.machineSSHPaths()
	c.warnProxy(alias)

	// The user's own ssh: OpenSSH asks about the host key (saved in
	// termote's known_hosts), then termote there says where it lives.
	if o.remoteExe != "" {
		rec.RemoteExe = strings.ReplaceAll(o.remoteExe, `\`, "/")
		rec.SocketDir = o.remoteSocketDir
		rec.RemoteOS = "linux"
		if winAbsRe.MatchString(rec.RemoteExe) {
			rec.RemoteOS, rec.SocketDir = "windows", ""
		}
		if err := checkMachineRecord(rec); err != nil {
			return usageError("%v", err)
		}
		c.stepf("ssh", "Connecting to %s to learn its host key", alias)
		if _, err := c.interact("", sshUserArgv(paths.KnownHosts, rec, "exit")); err != nil {
			return fmt.Errorf("ssh %s failed: %v", alias, err)
		}
	} else {
		w, err := c.findRemoteTermote(alias, rec, paths, o.yes)
		if err != nil {
			return err
		}
		rec.RemoteExe, rec.SocketDir, rec.RemoteOS = w.Exe, w.SocketDir, w.OS
		if !w.Native {
			c.warnf("termote on %s has no saved config: run 'termote start' there (container mode cannot be reached)", alias)
		}
		if w.APIVersion != 0 && w.APIVersion != apiVersion {
			c.warnf("termote on %s speaks API %d, this one %d: update the older one", alias, w.APIVersion, apiVersion)
		}
	}

	line := authorizedKeyLine(rec, pub)
	switch {
	case o.printKey || rec.RemoteOS == "windows":
		c.printKeyLine(alias, rec, line)
	case o.yes || c.confirm(fmt.Sprintf("Install a key on %s that can only run 'termote bridge'?", alias)):
		c.stepf("ssh", "Installing the key on %s", alias)
		if _, err := c.interact(line+"\n", sshUserArgv(paths.KnownHosts, rec, installKeyScript)); err != nil {
			return fmt.Errorf("installing the key on %s failed: %v", alias, err)
		}
	default:
		return errors.New("not added: the key was not installed (use --print-key to install it yourself)")
	}

	if !o.noCheck {
		if err := c.checkMachine(rec); err != nil {
			return fmt.Errorf("%s: %v; not added (fix it and add again, or add with --no-check)", alias, machineCheckHint(err))
		}
		c.infof("%s answers", alias)
	}
	if err := saveMachines(c.machinesFile(), append(list, rec)); err != nil {
		return err
	}
	c.infof("Added %s (id %s)", rec.Label, rec.ID)
	c.reloadMachines()
	return nil
}

// whereamiOn asks termote on the machine where it lives (whereamiScript).
func (c *cli) whereamiOn(alias string, rec machineRecord, paths sshPaths) (whereami, error) {
	out, err := c.interact("", sshUserArgv(paths.KnownHosts, rec, whereamiScript))
	w, perr := parseWhereami(out)
	// The script exits 3 or 4 after saying termote is missing or too old:
	// that answer came from the machine, so it wins over ssh's exit status.
	if errors.Is(perr, errTermoteNotFound) || errors.Is(perr, errTermoteTooOld) {
		return w, perr
	}
	if perr != nil && err != nil {
		return w, fmt.Errorf("ssh %s failed: %v (a Windows machine: add it with --remote-exe <path of termote.exe> --print-key)", alias, err)
	}
	return w, perr
}

// findRemoteTermote finds termote on a Unix machine. Where it is missing,
// it offers to install this release there and start it; where it is older
// than this one, to update it. Both run the machine's own installer or
// termote, over the user's ssh, after a yes (or --yes).
func (c *cli) findRemoteTermote(alias string, rec machineRecord, paths sshPaths, yes bool) (whereami, error) {
	c.stepf("ssh", "Connecting to %s to find termote there", alias)
	w, err := c.whereamiOn(alias, rec, paths)
	pin := c.version
	if !versionRe.MatchString(pin) {
		pin = ""
	}
	switch {
	case errors.Is(err, errTermoteNotFound):
		what := "the latest Termote"
		if pin != "" {
			what = "Termote " + pin
		}
		if !yes && !c.confirm(fmt.Sprintf("termote was not found on %s. Install %s there and start it?", alias, what)) {
			return w, fmt.Errorf("%s: %w", alias, err)
		}
		c.stepf("ssh", "Installing %s on %s", what, alias)
		if _, err := c.interact("", sshUserArgv(paths.KnownHosts, rec, remoteInstallScript(pin))); err != nil {
			return w, fmt.Errorf("installing termote on %s failed: %v", alias, err)
		}
		if w, err = c.whereamiOn(alias, rec, paths); err != nil {
			return w, fmt.Errorf("%s: %w", alias, err)
		}
		// Started even when a saved config is there: one left by an
		// uninstall without --purge says nothing runs, and a termote
		// just installed cannot be running yet. start keeps its options.
		c.stepf("ssh", "Starting termote on %s", alias)
		if _, err := c.interact("", sshUserArgv(paths.KnownHosts, rec, remoteExeScript(w.Exe, "start"))); err != nil {
			return w, fmt.Errorf("starting termote on %s failed: %v (run 'termote start' there)", alias, err)
		}
		return c.whereamiOn(alias, rec, paths)
	case errors.Is(err, errTermoteTooOld):
		// Too old for whereami, so too old for the bridge: it has to be
		// updated before it can be added.
		old := "an older version"
		if w.Version != "" {
			old = w.Version
		}
		if pin == "" || w.Exe == "" {
			return w, fmt.Errorf("%s: termote there is %s, too old to be reached: update it there (termote update), then add it again", alias, old)
		}
		if !yes && !c.confirm(fmt.Sprintf("termote on %s is %s, too old to be reached. Update it there to %s (its server restarts)?", alias, old, pin)) {
			return w, fmt.Errorf("%s: termote there is %s, too old to be reached: update it there (termote update), then add it again", alias, old)
		}
		c.stepf("ssh", "Updating termote on %s to %s", alias, pin)
		if _, err := c.interact("", sshUserArgv(paths.KnownHosts, rec, remoteExeScript(w.Exe, "update", "--version", pin))); err != nil {
			return w, fmt.Errorf("updating termote on %s failed: %v (update it there, then add it again)", alias, err)
		}
		if w, err = c.whereamiOn(alias, rec, paths); err != nil {
			return w, fmt.Errorf("%s: %w", alias, err)
		}
		return w, nil
	case err != nil:
		return w, err
	}
	if pin != "" && versionRe.MatchString(w.Version) && compareVersions(w.Version, pin) < 0 &&
		(yes || c.confirm(fmt.Sprintf("termote on %s is %s, this one %s. Update it there (its server restarts)?", alias, w.Version, pin))) {
		c.stepf("ssh", "Updating termote on %s to %s", alias, pin)
		if _, err := c.interact("", sshUserArgv(paths.KnownHosts, rec, remoteExeScript(w.Exe, "update", "--version", pin))); err != nil {
			c.warnf("updating termote on %s failed: %v", alias, err)
			return w, nil
		}
		return c.whereamiOn(alias, rec, paths)
	}
	return w, nil
}

// printKeyLine prints the line to install by hand.
func (c *cli) printKeyLine(alias string, rec machineRecord, line string) {
	c.heading("Key for " + alias)
	if rec.RemoteOS == "windows" {
		fmt.Fprintln(c.out, "Add this line to the account's .ssh\\authorized_keys on the machine, or for an administrator")
		fmt.Fprintln(c.out, "to C:\\ProgramData\\ssh\\administrators_authorized_keys:")
	} else {
		fmt.Fprintln(c.out, "Add this line to ~/.ssh/authorized_keys on the machine:")
	}
	fmt.Fprintf(c.out, "\n%s\n\n", line)
}

// ensureMachineKey makes termote's key the first time and returns its
// public half. The private key is never printed.
func (c *cli) ensureMachineKey() (string, error) {
	p := c.machineSSHPaths()
	if err := os.MkdirAll(c.machineSSHDir(), 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(c.machineSSHDir(), 0o700); err != nil {
		return "", err
	}
	if !fileExists(p.Key) {
		host, _ := os.Hostname()
		if host == "" {
			host = "host"
		}
		argv := sshKeygenArgv(p.Key, "termote@"+host)
		if _, err := c.run.Output("", nil, argv[0], argv[1:]...); err != nil {
			return "", fmt.Errorf("ssh-keygen failed: %v", err)
		}
	}
	pub, err := os.ReadFile(p.Key + ".pub")
	if err != nil {
		return "", err
	}
	if publicKeyBlob(string(pub)) == "" {
		return "", fmt.Errorf("%s.pub is not a public key", p.Key)
	}
	return strings.TrimSpace(string(pub)), nil
}

// warnProxy warns when the alias reaches its machine through a
// ProxyCommand or ProxyJump: termote's key would have to open the jump
// host too.
func (c *cli) warnProxy(alias string) {
	out, err := c.run.Output("", nil, "ssh", "-G", "--", alias)
	if err != nil {
		return
	}
	for _, l := range strings.Split(string(out), "\n") {
		f := strings.Fields(l)
		if len(f) >= 2 && (f[0] == "proxycommand" || f[0] == "proxyjump") && f[1] != "none" {
			c.warnf("%s goes through a %s, which termote does not support: it may not connect", alias, f[0])
			return
		}
	}
}

// machineDial dials a machine for the CLI's check. Tests replace it.
var machineDial = func(ctx context.Context, p sshPaths, m machineRecord) (net.Conn, string, error) {
	return dialMachineSSH(ctx, sshBridgeArgv(p, m, ""))
}

// checkMachine connects as the service will (termote's key, no prompt),
// reads the bridge's greeting and its health.
func (c *cli) checkMachine(m machineRecord) error {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	conn, _, err := machineDial(ctx, c.machineSSHPaths(), m)
	if err != nil {
		return err
	}
	defer conn.Close()
	return checkMachineHealth(ctx, conn)
}

// checkMachineHealth asks the bridge for health over conn: an apiVersion
// other than this one's is incompatible.
func checkMachineHealth(ctx context.Context, conn net.Conn) error {
	var used atomic.Bool
	cl := &http.Client{Transport: &http.Transport{DisableKeepAlives: true,
		DialContext: func(context.Context, string, string) (net.Conn, error) {
			if used.Swap(true) {
				return nil, errors.New("connection already used")
			}
			return conn, nil
		}}}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+localSocketHost+"/api/mux/health", nil)
	resp, err := cl.Do(req)
	if err != nil {
		return errMachineOffline
	}
	defer resp.Body.Close()
	var h struct {
		APIVersion int `json:"apiVersion"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&h) != nil || h.APIVersion != apiVersion {
		return errMachineIncompatible
	}
	return nil
}

// machineCheckHint says what to do about a failed check.
func machineCheckHint(err error) string {
	switch {
	case errors.Is(err, errMachineUnauthorized):
		return "unauthorized: the key is not installed there (or without the forced command)"
	case errors.Is(err, errMachineHostKey):
		return "host key changed: if that is expected, remove the machine and add it again"
	case errors.Is(err, errMachineIncompatible):
		return "incompatible: update termote on both machines to the same release"
	case errors.Is(err, errMachineNoServer):
		return "no termote server: run 'termote start' on the machine"
	}
	return "offline: the machine did not answer over SSH"
}

func (c *cli) machineList(args []string) error {
	asJSON := false
	fs := c.newFlagSet("machine list")
	fs.BoolVar(&asJSON, "json", false, "")
	if pos, err := parseArgs(fs, args); err != nil {
		return flagErr(err)
	} else if len(pos) > 0 {
		return usageError("usage: termote machine list [--json]")
	}
	list, err := loadMachines(c.machinesFile())
	if err != nil {
		return err
	}
	if asJSON {
		if list == nil {
			list = []machineRecord{}
		}
		return json.NewEncoder(c.out).Encode(map[string]any{"machines": list})
	}
	c.heading("Machines")
	if len(list) == 0 {
		fmt.Fprintln(c.out, "  None. Add one: termote machine add <ssh alias>")
		fmt.Fprintln(c.out)
		return nil
	}
	tw := tabwriter.NewWriter(c.out, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "  ID\tLABEL\tALIAS\tADDED")
	for _, m := range list {
		fmt.Fprintf(tw, "  %s\t%s\t%s\t%s\n", m.ID, m.Label, m.Alias, m.AddedAt.Local().Format("2006-01-02"))
	}
	tw.Flush()
	fmt.Fprintln(c.out)
	return nil
}

func (c *cli) machineRemove(args []string) error {
	var yes, keepKey bool
	fs := c.newFlagSet("machine remove")
	fs.BoolVar(&yes, "yes", false, "")
	fs.BoolVar(&keepKey, "keep-remote-key", false, "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	if len(pos) != 1 {
		return usageError("usage: termote machine remove <id|label>")
	}
	list, err := loadMachines(c.machinesFile())
	if err != nil {
		return err
	}
	i := findMachine(list, pos[0])
	if i < 0 {
		return fmt.Errorf("no machine %q (list them: termote machine list)", pos[0])
	}
	m := list[i]
	if err := saveMachines(c.machinesFile(), append(list[:i:i], list[i+1:]...)); err != nil {
		return err
	}
	c.infof("Removed %s", m.Label)
	c.reloadMachines()
	paths := c.machineSSHPaths()
	if !keepKey && m.RemoteOS != "windows" && (yes || c.confirm(fmt.Sprintf("Remove termote's key from %s too (over your ssh)?", m.Alias))) {
		if pub, err := os.ReadFile(paths.Key + ".pub"); err == nil && publicKeyBlob(string(pub)) != "" {
			if _, err := c.interact(publicKeyBlob(string(pub))+"\n", sshUserArgv(paths.KnownHosts, m, removeKeyScript)); err != nil {
				c.warnf("the key could not be removed from %s: %v", m.Alias, err)
			}
		}
	}
	if fileExists(paths.KnownHosts) {
		argv := sshForgetHostArgv(paths.KnownHosts, m.ID)
		if _, err := c.run.Output("", nil, argv[0], argv[1:]...); err != nil {
			c.warnf("its host key stays in %s: %v", paths.KnownHosts, err)
		}
	}
	return nil
}

// machineStatusView is a machine's status as status prints it.
type machineStatusView struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Status string `json:"status"`
}

func (c *cli) machineStatusCmd(args []string) error {
	asJSON := false
	fs := c.newFlagSet("machine status")
	fs.BoolVar(&asJSON, "json", false, "")
	if pos, err := parseArgs(fs, args); err != nil {
		return flagErr(err)
	} else if len(pos) > 0 {
		return usageError("usage: termote machine status [--json]")
	}
	views, err := c.machineStatuses()
	if err != nil {
		return err
	}
	if asJSON {
		return json.NewEncoder(c.out).Encode(map[string]any{"machines": views})
	}
	c.heading("Machines")
	if len(views) == 0 {
		fmt.Fprintln(c.out, "  None. Add one: termote machine add <ssh alias>")
		fmt.Fprintln(c.out)
		return nil
	}
	tw := tabwriter.NewWriter(c.out, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "  ID\tLABEL\tSTATUS")
	for _, v := range views {
		fmt.Fprintf(tw, "  %s\t%s\t%s\n", v.ID, v.Label, v.Status)
	}
	tw.Flush()
	fmt.Fprintln(c.out)
	return nil
}

// machineStatuses asks the running server (over the local socket), else
// checks each machine itself.
func (c *cli) machineStatuses() ([]machineStatusView, error) {
	saved, _ := c.loadConfig()
	if resp, out := c.socketRequest(c.savedPort(saved), http.MethodGet, "/api/mux/machines", nil); out == socketAnswered {
		defer resp.Body.Close()
		var res struct {
			Machines []machineStatusView `json:"machines"`
		}
		if resp.StatusCode == http.StatusOK && json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&res) == nil {
			if res.Machines == nil {
				res.Machines = []machineStatusView{}
			}
			return res.Machines, nil
		}
	}
	list, err := loadMachines(c.machinesFile())
	if err != nil {
		return nil, err
	}
	views := []machineStatusView{}
	for _, m := range list {
		views = append(views, machineStatusView{ID: m.ID, Label: m.Label, Status: machineStatus(c.checkMachine(m))})
	}
	return views, nil
}

// reloadMachines tells the running server the list changed, so no restart
// is needed. A server not reached picks it up when it starts.
func (c *cli) reloadMachines() {
	saved, _ := c.loadConfig()
	resp, out := c.socketRequest(c.savedPort(saved), http.MethodPost, "/api/mux/machines/reload", []byte("{}"))
	if out != socketAnswered {
		return
	}
	resp.Body.Close()
}

// machineImport adds the machines Herdr knows, each after a yes.
func (c *cli) machineImport(args []string) error {
	herdr := false
	fs := c.newFlagSet("machine import")
	fs.BoolVar(&herdr, "herdr", false, "")
	if pos, err := parseArgs(fs, args); err != nil {
		return flagErr(err)
	} else if len(pos) > 0 || !herdr {
		return usageError("usage: termote machine import --herdr")
	}
	if _, err := c.run.LookPath("herdr"); err != nil {
		return errors.New("herdr was not found: nothing to import")
	}
	out, err := c.run.Output("", nil, "herdr", "machine", "list", "--json")
	if err != nil {
		return fmt.Errorf("herdr machine list failed: %v", err)
	}
	aliases, err := parseHerdrMachines(out)
	if err != nil {
		return err
	}
	if len(aliases) == 0 {
		c.infof("Herdr has no machines")
		return nil
	}
	var failed int
	for _, a := range aliases {
		if validAlias(a) != nil {
			c.warnf("skipped %q: not an ssh alias termote takes", a)
			continue
		}
		if !c.confirm(fmt.Sprintf("Add %s?", a)) {
			continue
		}
		if err := c.addMachine(a, machineAddOpts{}); err != nil {
			c.errorf("%s: %v", a, err)
			failed++
		}
	}
	if failed > 0 {
		return &exitError{code: 1}
	}
	return nil
}

// parseHerdrMachines reads `herdr machine list --json`: a list of machines,
// bare or under "machines", each a string or an object naming its ssh
// destination.
func parseHerdrMachines(out []byte) ([]string, error) {
	var raw json.RawMessage = out
	var wrapped struct {
		Machines json.RawMessage `json:"machines"`
	}
	if json.Unmarshal(out, &wrapped) == nil && wrapped.Machines != nil {
		raw = wrapped.Machines
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, errors.New("herdr machine list --json gave no list of machines")
	}
	var aliases []string
	for _, it := range items {
		var s string
		if json.Unmarshal(it, &s) == nil {
			aliases = append(aliases, s)
			continue
		}
		var o map[string]any
		if json.Unmarshal(it, &o) != nil {
			continue
		}
		for _, k := range []string{"ssh", "host", "alias", "name"} {
			if v, ok := o[k].(string); ok && v != "" {
				aliases = append(aliases, v)
				break
			}
		}
	}
	return aliases, nil
}

// machineWhereami prints where this termote lives, for another termote's
// machine add: the path its forced command runs (a path that survives
// update; on Windows termote.exe itself, since cmd.exe would mangle the
// bridge's bytes) and the socket dir of the bridge.
func (c *cli) machineWhereami() error {
	saved, _ := c.loadConfig()
	w := whereami{Exe: c.stableExe(), OS: c.goos, Version: c.version, APIVersion: apiVersion, Native: saved != nil}
	if c.goos == "windows" {
		if strings.HasSuffix(strings.ToLower(w.Exe), ".cmd") {
			w.Exe = c.exe
		}
		w.Exe = strings.ReplaceAll(w.Exe, `\`, "/")
	} else {
		w.SocketDir = c.localSocketDir()
	}
	return json.NewEncoder(c.out).Encode(w)
}
