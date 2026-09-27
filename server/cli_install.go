package main

import (
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

// procInfo describes a running process. Cmdline is argv joined by spaces
// (Unix) or the image name (Windows); Exe is the image path when known.
type procInfo struct {
	PID     int
	Cmdline string
	Exe     string
}

// installOptions are the install flags after merging the saved config.
type installOptions struct {
	mode        string
	lan         bool
	noAuth      bool
	fresh       bool
	herdrNoAuth bool
	port        int
	tailscale   string
	mux         string
	allowHosts  []string // user-added names, persisted
}

func (c *cli) parseInstallArgs(args []string) (installOptions, map[string]bool, error) {
	var o installOptions
	var hosts stringList
	fs := c.newFlagSet("install")
	fs.BoolVar(&o.lan, "lan", false, "")
	fs.BoolVar(&o.noAuth, "no-auth", false, "")
	fs.BoolVar(&o.fresh, "fresh", false, "")
	fs.BoolVar(&o.herdrNoAuth, "allow-herdr-no-auth", false, "")
	fs.IntVar(&o.port, "port", 0, "")
	fs.StringVar(&o.tailscale, "tailscale", "", "")
	fs.StringVar(&o.mux, "mux", "", "")
	fs.Var(&hosts, "allow-host", "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return o, nil, flagErr(err)
	}
	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	if len(pos) != 1 {
		return o, nil, usageError("usage: termote install <container|native> [options]")
	}
	o.mode = pos[0]
	if o.mode == "docker" {
		o.mode = "container"
	}
	o.allowHosts = hosts
	return o, set, nil
}

// mergeSaved applies saved values for every flag not given on the command
// line; --allow-host names add to the saved ones.
func mergeSaved(o *installOptions, set map[string]bool, s *savedConfig) {
	if !set["lan"] {
		o.lan = s.LAN
	}
	if !set["no-auth"] {
		o.noAuth = s.NoAuth
	}
	if !set["port"] && s.Port != 0 {
		o.port = s.Port
	}
	if !set["tailscale"] {
		o.tailscale = s.Tailscale
	}
	if !set["mux"] && s.Mux != "" && o.mode == "native" {
		o.mux = s.Mux
	}
	if !set["allow-herdr-no-auth"] {
		o.herdrNoAuth = s.HerdrAllowNoAuth
	}
	for _, h := range s.AllowHosts {
		if !slices.Contains(o.allowHosts, h) {
			o.allowHosts = append(o.allowHosts, h)
		}
	}
	slices.Sort(o.allowHosts)
}

func (c *cli) validateInstall(o *installOptions) error {
	if o.mode != "native" && o.mode != "container" {
		return usageError("unknown mode %q (use: native, container)", o.mode)
	}
	if o.port == 0 {
		o.port = c.defaultPort()
	}
	if o.port < 1 || o.port > 65535 {
		return usageError("invalid port: %d", o.port)
	}
	if o.mux == "" {
		o.mux = "tmux"
	}
	switch o.mux {
	case "tmux":
	case "herdr":
		if o.mode != "native" {
			return usageError("--mux herdr needs native mode (herdr runs on the host)")
		}
		if o.noAuth && !o.herdrNoAuth {
			return usageError("--mux herdr --no-auth would expose every herdr workspace without a password; add --allow-herdr-no-auth to accept that")
		}
	default:
		return usageError("unknown --mux %q (use: tmux, herdr)", o.mux)
	}
	for _, h := range o.allowHosts {
		if err := validateHostName(h); err != nil {
			return usageError("%v", err)
		}
	}
	if o.tailscale != "" {
		host, port := splitTailscale(o.tailscale)
		if err := validateHostName(host); err != nil {
			return usageError("invalid --tailscale: %v", err)
		}
		if p, err := strconv.Atoi(port); err != nil || p < 1 || p > 65535 {
			return usageError("invalid --tailscale port %q", port)
		}
	}
	return nil
}

// splitTailscale splits "host[:port]"; the HTTPS port defaults to 443.
func splitTailscale(v string) (host, port string) {
	if h, p, ok := strings.Cut(v, ":"); ok {
		return h, p
	}
	return v, "443"
}

func (c *cli) cmdInstall(args []string) error {
	o, set, err := c.parseInstallArgs(args)
	if err != nil {
		return err
	}
	saved, err := c.loadConfig()
	if err != nil {
		return fmt.Errorf("cannot read %s (%v); fix or delete it, then install again", c.configFile(), err)
	}
	if saved != nil && !o.fresh {
		mergeSaved(&o, set, saved)
	}
	if err := c.validateInstall(&o); err != nil {
		return err
	}
	if err := c.preflight(o); err != nil {
		return err
	}
	release := !c.isCheckout()
	if release {
		c.infof("Release mode (using pre-built artifacts)")
	}

	c.heading("Termote Install (" + o.mode + ")")

	// Stop everything first: no port conflicts, no busy binary on copy.
	c.stopNative()
	c.stopContainers(false)

	c.stepf("1/4", "Setting up PWA...")
	if err := c.setupPWA(release); err != nil {
		return err
	}
	c.stepf("2/4", "Setting up the server...")
	if err := c.setupServerBinary(o.mode, release); err != nil {
		return err
	}
	c.stepf("3/4", "Setting up auth...")
	pass, reused, err := c.setupAuth(o, saved)
	if err != nil {
		return err
	}
	c.stepf("4/4", "Starting services...")
	hosts := computeAllowedHosts(o, c.localIPv4s())
	if o.mode == "native" {
		err = c.startNative(o, pass, hosts)
	} else {
		err = c.startContainer(o, pass, hosts)
	}
	if err != nil {
		return err
	}
	c.setupTailscale(o.tailscale, o.port, saved != nil && saved.Tailscale != "")

	if err := c.saveConfig(savedConfig{
		Mode:             o.mode,
		LAN:              o.lan,
		NoAuth:           o.noAuth,
		Port:             o.port,
		Tailscale:        o.tailscale,
		Mux:              o.mux,
		AllowHosts:       o.allowHosts,
		HerdrAllowNoAuth: o.herdrNoAuth,
		Password:         pass,
	}); err != nil {
		c.warnf("Could not save config: %v", err)
	}
	c.showAccessInfo(o, hosts, pass, reused)
	return nil
}

// setupAuth returns the password to run with; empty means auth is off.
func (c *cli) setupAuth(o installOptions, saved *savedConfig) (pass string, reused bool, err error) {
	if o.noAuth {
		c.infof("Basic auth disabled")
		// Allowed, but anyone who reaches the port gets a shell.
		if o.lan || o.tailscale != "" {
			c.warnf("Auth is off while other machines can reach this server (--lan/--tailscale): anyone on that network gets a shell. Drop --no-auth unless the network is trusted.")
		}
		return "", false, nil
	}
	if !o.fresh && saved != nil {
		switch {
		case saved.Password != "":
			c.infof("Using saved password (use --fresh to reset)")
			return saved.Password, true, nil
		case saved.PasswordUnreadable:
			c.warnf("Saved password cannot be decrypted on this machine/user; setting a new one")
		default:
			// Auth on with no saved password never runs without auth.
			c.warnf("Saved config has no password; setting a new one")
		}
	}
	if c.interactive {
		fmt.Fprint(c.out, "Enter password for admin (Enter = auto-generate): ")
		p, err := c.readPassword()
		if err == nil && p != "" {
			c.infof("Using provided password")
			return p, false, nil
		}
	}
	p, err := generatePassword()
	if err != nil {
		return "", false, err
	}
	c.infof("Auto-generated password")
	return p, false, nil
}

// webuiDist is where the PWA build is copied before `go build` embeds it.
func (c *cli) webuiDist() string {
	return filepath.Join(c.projectDir, "server", "webui", "dist")
}

// setupPWA builds the PWA in a checkout and copies it where the server build
// embeds it. A release binary already carries it.
func (c *cli) setupPWA(release bool) error {
	if release {
		return nil
	}
	if err := c.run.Run(c.projectDir, nil, "pnpm", "install", "--frozen-lockfile", "--filter", "termote..."); err != nil {
		return fmt.Errorf("pnpm install: %w", err)
	}
	if err := c.run.Run(c.projectDir, nil, "pnpm", "--filter", "termote", "build"); err != nil {
		return fmt.Errorf("PWA build: %w", err)
	}
	return syncPWABuild(filepath.Join(c.projectDir, "pwa", "dist"), c.webuiDist())
}

// syncPWABuild replaces everything in dst but .gitkeep with a copy of src, so
// stale hashed assets are never embedded again.
func syncPWABuild(src, dst string) error {
	if !fileExists(filepath.Join(src, "index.html")) {
		return fmt.Errorf("PWA build not found in %s", src)
	}
	entries, err := os.ReadDir(dst)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	for _, e := range entries {
		if e.Name() == ".gitkeep" {
			continue
		}
		if err := os.RemoveAll(filepath.Join(dst, e.Name())); err != nil {
			return err
		}
	}
	return os.CopyFS(dst, os.DirFS(src))
}

// serverBinary is what native mode runs: a copy of the CLI binary (or a fresh
// build in a checkout) under a name reserved for the server.
func (c *cli) serverBinary(mode string) string {
	if mode == "container" {
		return filepath.Join(c.projectDir, "server", "termote-linux-"+c.goarch)
	}
	return filepath.Join(c.projectDir, "server", "termote-server"+c.exeSuffix())
}

func (c *cli) setupServerBinary(mode string, release bool) error {
	dst := c.serverBinary(mode)
	if err := ensureDir(filepath.Dir(dst)); err != nil {
		return err
	}
	if !release {
		goos := c.goos
		if mode == "container" {
			goos = "linux"
		}
		c.infof("Building the server (%s/%s)...", goos, c.goarch)
		env := environ(map[string]string{"CGO_ENABLED": "0", "GOOS": goos, "GOARCH": c.goarch})
		if err := c.run.Run(filepath.Join(c.projectDir, "server"), env, "go", "build", "-ldflags=-s -w", "-o", filepath.Base(dst), "."); err != nil {
			return fmt.Errorf("build server: %w", err)
		}
		return nil
	}
	if mode == "container" {
		return errors.New("container mode needs a git checkout (the image is built from its Dockerfile)")
	}
	if sameFile(c.exe, dst) {
		return nil
	}
	return copyExecutable(c.exe, dst)
}

func sameFile(a, b string) bool {
	sa, err1 := os.Stat(a)
	sb, err2 := os.Stat(b)
	return err1 == nil && err2 == nil && os.SameFile(sa, sb)
}

// copyExecutable writes src to dst through a temp file and a rename.
func copyExecutable(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("pre-built binary not found: %s", src)
	}
	defer in.Close()
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return renameOver(tmp, dst)
}

// renameOver moves tmp onto dst. Windows refuses to overwrite a running
// executable, so dst is then renamed aside first and the move retried.
func renameOver(tmp, dst string) error {
	if err := os.Rename(tmp, dst); err == nil {
		return nil
	}
	if err := replaceRunningFile(dst); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// computeAllowedHosts is TERMOTE_ALLOWED_HOSTS: LAN addresses with --lan, the
// Tailscale name with --tailscale, and the --allow-host names. The server
// always adds loopback.
func computeAllowedHosts(o installOptions, lanIPs []string) []string {
	var hosts []string
	add := func(h string) {
		h = strings.ToLower(h)
		if h != "" && !slices.Contains(hosts, h) {
			hosts = append(hosts, h)
		}
	}
	if o.lan {
		for _, ip := range lanIPs {
			add(ip)
		}
	}
	if o.tailscale != "" {
		host, _ := splitTailscale(o.tailscale)
		add(host)
	}
	for _, h := range o.allowHosts {
		add(h)
	}
	return hosts
}

// localIPv4s lists the non-loopback, non-link-local IPv4 addresses of the
// interfaces that are up.
func localIPv4s() []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var ips []string
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipn.IP.To4()
			if ip == nil || ip.IsLinkLocalUnicast() || ip.IsLoopback() {
				continue
			}
			ips = append(ips, ip.String())
		}
	}
	return ips
}

// serverEnv is the environment the server reads (see newServeConfigFromEnv).
// TERMOTE_PWA_DIR is cleared so the server serves its embedded PWA.
func serverEnv(o installOptions, bind, pass string, hosts []string) map[string]string {
	noAuth, herdrNoAuth := "", ""
	if o.noAuth {
		noAuth = "true"
	}
	if o.herdrNoAuth {
		herdrNoAuth = "true"
	}
	return map[string]string{
		"TERMOTE_PORT":                strconv.Itoa(o.port),
		"TERMOTE_BIND":                bind,
		"TERMOTE_PWA_DIR":             "",
		"TERMOTE_USER":                adminUser,
		"TERMOTE_PASS":                pass,
		"TERMOTE_NO_AUTH":             noAuth,
		"TERMOTE_MUX":                 o.mux,
		"TERMOTE_ALLOWED_HOSTS":       strings.Join(hosts, ","),
		"TERMOTE_HERDR_ALLOW_NO_AUTH": herdrNoAuth,
	}
}

// preflight checks the tools the mode needs before any service is stopped.
func (c *cli) preflight(o installOptions) error {
	if o.mode == "container" {
		if c.containerRuntime() == "" {
			return errors.New("neither podman nor docker found; install one")
		}
		if !c.isCheckout() {
			return errors.New("container mode needs a git checkout (the image is built from its Dockerfile)")
		}
		return nil
	}
	switch o.mux {
	case "tmux":
		if _, err := c.run.LookPath("tmux"); err != nil {
			if c.goos == "windows" {
				return errors.New("psmux not found. Install it: winget install psmux (https://github.com/psmux/psmux)")
			}
			return errors.New("tmux not found. Install it: brew install tmux (macOS) or sudo apt install tmux (Debian/Ubuntu)")
		}
	case "herdr":
		if _, err := c.run.LookPath("herdr"); err != nil {
			return errors.New("herdr not found in PATH; install herdr or use --mux tmux")
		}
	}
	return nil
}

func (c *cli) startNative(o installOptions, pass string, hosts []string) error {
	bind := "127.0.0.1"
	if o.lan {
		bind = "0.0.0.0"
	}
	if err := ensureDir(c.logDir()); err != nil {
		return err
	}
	if err := portFree(bind, o.port); err != nil {
		return fmt.Errorf("port %d is in use by another program (%v); stop it or choose --port", o.port, err)
	}
	bin := c.serverBinary("native")
	env := environ(serverEnv(o, bind, pass, hosts))
	logPath := filepath.Join(c.logDir(), "termote.log")
	pid, exited, err := startDetached(bin, c.projectDir, env, logPath)
	if err != nil {
		return fmt.Errorf("start server: %w", err)
	}
	if err := os.WriteFile(c.pidFile(), []byte(strconv.Itoa(pid)+"\n"), 0o600); err != nil {
		c.warnf("Could not write %s: %v", c.pidFile(), err)
	}
	if !c.waitForServer(o.port, serverStartWait, exited) {
		removeFile(c.pidFile())
		return fmt.Errorf("server did not start; last log lines:\n%s", tailFile(logPath, 15))
	}
	c.infof("Native mode started (backend: %s, pid %d)", o.mux, pid)
	return nil
}

// portFree reports an error when bind:port cannot be listened on.
func portFree(bind string, port int) error {
	ln, err := net.Listen("tcp", net.JoinHostPort(bind, strconv.Itoa(port)))
	if err != nil {
		return err
	}
	return ln.Close()
}

// waitForServer polls the health endpoint until any HTTP answer arrives, the
// process exits (exited closes) or the timeout passes. With exited set, the
// process must still be alive a moment after the answer, so a server that
// died on a bind error is not mistaken for up.
func (c *cli) waitForServer(port int, timeout time.Duration, exited <-chan struct{}) bool {
	client := &http.Client{Timeout: time.Second}
	url := fmt.Sprintf("http://127.0.0.1:%d/api/mux/health", port)
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if resp, err := client.Get(url); err == nil {
			resp.Body.Close()
			if exited == nil {
				return true
			}
			select {
			case <-exited:
				return false
			case <-time.After(300 * time.Millisecond):
				return true
			}
		}
		select {
		case <-exited:
			return false
		case <-time.After(200 * time.Millisecond):
		}
	}
	return false
}

// containerStartWait bounds the wait for a freshly started container.
var containerStartWait = 30 * time.Second

// containerRuntime prefers podman, the lighter of the two.
func (c *cli) containerRuntime() string {
	for _, rt := range []string{"podman", "docker"} {
		if _, err := c.run.LookPath(rt); err == nil {
			return rt
		}
	}
	return ""
}

func (c *cli) startContainer(o installOptions, pass string, hosts []string) error {
	rt := c.containerRuntime()
	c.infof("Using %s", rt)
	workspace := os.Getenv("WORKSPACE")
	if workspace == "" {
		workspace = filepath.Join(c.projectDir, "workspace")
	}
	c.warnSensitiveDirs(workspace)
	// Docker Desktop does not create missing bind-mount sources, and Docker
	// on Linux would create it owned by root.
	if err := ensureDir(workspace); err != nil {
		return err
	}
	// Windows maps to localhost only; LAN goes through netsh portproxy.
	bind := "127.0.0.1"
	if o.lan && c.goos != "windows" {
		bind = "0.0.0.0"
	}
	override := filepath.Join(c.projectDir, "docker-compose.override.yml")
	yml := fmt.Sprintf("services:\n  termote:\n    ports:\n      - \"%s:%d:%d\"\n", bind, o.port, containerPort)
	if err := os.WriteFile(override, []byte(yml), 0o644); err != nil {
		return err
	}
	defer os.Remove(override)

	vars := map[string]string{
		"NO_AUTH":               strconv.FormatBool(o.noAuth),
		"TERMOTE_PASS":          pass,
		"TERMOTE_ALLOWED_HOSTS": strings.Join(hosts, ","),
	}
	if uid, gid := os.Getuid(), os.Getgid(); uid >= 0 && gid >= 0 {
		vars["USER_ID"], vars["GROUP_ID"] = strconv.Itoa(uid), strconv.Itoa(gid)
	}
	if err := c.run.Run(c.projectDir, environ(vars), rt, "compose", "--profile", "docker", "up", "-d", "--build"); err != nil {
		return fmt.Errorf("failed to start container: %w", err)
	}
	if o.lan && c.goos == "windows" {
		c.setupPortProxy(o.port)
	}
	if !c.waitForServer(o.port, containerStartWait, nil) {
		c.warnf("Container started but the server does not answer yet; check: %s logs %s", rt, containerName)
	}
	return nil
}

func (c *cli) warnSensitiveDirs(workspace string) {
	var found []string
	for _, d := range []string{".ssh", ".gnupg", ".aws", filepath.Join(".config", "gcloud")} {
		if isDir(filepath.Join(workspace, d)) {
			found = append(found, d)
		}
	}
	if len(found) > 0 {
		c.warnf("WORKSPACE contains sensitive directories: %s", strings.Join(found, ", "))
		c.warnf("These will be accessible inside the container. Consider using a subdirectory.")
	}
}

// runElevated runs a PowerShell script through a UAC prompt. The script is
// passed as -EncodedCommand so no quoting survives two shells.
func (c *cli) runElevated(script string) error {
	u := utf16.Encode([]rune(script))
	b := make([]byte, 2*len(u))
	for i, r := range u {
		b[2*i], b[2*i+1] = byte(r), byte(r>>8)
	}
	enc := base64.StdEncoding.EncodeToString(b)
	outer := "Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','" + enc + "'"
	return c.run.Run("", nil, "powershell", "-NoProfile", "-Command", outer)
}

func portProxyScript(port int, add bool) string {
	p := strconv.Itoa(port)
	s := "netsh interface portproxy delete v4tov4 listenport=" + p + " listenaddress=0.0.0.0 2>$null; " +
		"netsh advfirewall firewall delete rule name='Termote LAN' 2>$null"
	if add {
		s += "; netsh interface portproxy add v4tov4 listenport=" + p + " listenaddress=0.0.0.0 connectport=" + p + " connectaddress=127.0.0.1" +
			"; netsh advfirewall firewall add rule name='Termote LAN' dir=in action=allow protocol=tcp localport=" + p
	}
	return s
}

func (c *cli) setupPortProxy(port int) {
	c.infof("Setting up LAN port forwarding (netsh portproxy, needs Administrator)...")
	if err := c.runElevated(portProxyScript(port, true)); err != nil {
		c.warnf("LAN port forwarding failed (%v). Run as Administrator:", err)
		c.warnf("  netsh interface portproxy add v4tov4 listenport=%d listenaddress=0.0.0.0 connectport=%d connectaddress=127.0.0.1", port, port)
		c.warnf("  netsh advfirewall firewall add rule name=\"Termote LAN\" dir=in action=allow protocol=tcp localport=%d", port)
	}
}

// tailscaleCmd prefixes sudo on Unix unless already root.
func (c *cli) tailscaleCmd(args ...string) (string, []string) {
	if c.goos == "windows" || isElevated() {
		return "tailscale", args
	}
	return "sudo", append([]string{"tailscale"}, args...)
}

// setupTailscale serves the port over Tailscale HTTPS, or resets a serve
// config Termote set up earlier (never an unrelated one).
func (c *cli) setupTailscale(ts string, port int, hadSaved bool) {
	if _, err := c.run.LookPath("tailscale"); err != nil {
		if ts != "" {
			c.warnf("Tailscale not found in PATH; skipping Tailscale setup (https://tailscale.com/download)")
		}
		return
	}
	if ts != "" {
		c.infof("Setting up Tailscale serve...")
		_, tsPort := splitTailscale(ts)
		name, args := c.tailscaleCmd("serve", "--bg", "--https="+tsPort, fmt.Sprintf("http://127.0.0.1:%d", port))
		if err := c.run.Run("", nil, name, args...); err != nil {
			c.warnf("tailscale serve failed: %v", err)
		}
		return
	}
	if hadSaved {
		c.infof("Resetting previous Tailscale serve config...")
		name, args := c.tailscaleCmd("serve", "reset")
		c.run.Run("", nil, name, args...)
	}
}

func (c *cli) showAccessInfo(o installOptions, hosts []string, pass string, reused bool) {
	c.heading("Access Info")
	if o.tailscale != "" {
		host, port := splitTailscale(o.tailscale)
		fmt.Fprintf(c.out, "Tailscale: %s\n", c.paint(ansiCyan, "https://"+host+":"+port))
	}
	if o.lan {
		ip := "0.0.0.0"
		if ips := c.localIPv4s(); len(ips) > 0 {
			ip = ips[0]
		}
		fmt.Fprintf(c.out, "LAN: %s\n", c.paint(ansiCyan, fmt.Sprintf("http://%s:%d", ip, o.port)))
	} else if o.tailscale == "" {
		fmt.Fprintf(c.out, "Local: %s\n", c.paint(ansiCyan, fmt.Sprintf("http://localhost:%d", o.port)))
	}
	fmt.Fprintf(c.out, "Backend: %s\n", o.mux)
	fmt.Fprintf(c.out, "Allowed hosts: %s\n", strings.Join(append(slices.Clone(loopbackHosts), hosts...), ", "))
	fmt.Fprintf(c.out, "%s\n", c.paint(ansiDim, "  (another name? add it with --allow-host <name>)"))
	if pass == "" {
		return
	}
	if reused {
		c.infof("Using saved password (show it with: termote show-password)")
		return
	}
	c.showCredentials(pass)
}

func (c *cli) showCredentials(pass string) {
	line := c.paint(ansiBold, "============================================")
	fmt.Fprintf(c.out, "\n%s\n  %s\n  Username: %s\n  Password: %s\n%s\n%s\n", line,
		c.paint(ansiGreen, "TERMOTE CREDENTIALS"),
		c.paint(ansiCyan, adminUser), c.paint(ansiCyan, pass),
		c.paint(ansiDim, "  (view it again with: termote show-password)"), line)
}

// stopNative stops the server this install started (PID file) and any server
// whose command line is exactly what Termote runs; nothing broader, so
// servers the user started themselves keep running.
func (c *cli) stopNative() {
	procs, err := c.procs()
	if err != nil {
		c.warnf("Cannot list processes: %v", err)
		return
	}
	pidFromFile := 0
	if b, err := os.ReadFile(c.pidFile()); err == nil {
		pidFromFile, _ = strconv.Atoi(strings.TrimSpace(string(b)))
	}
	for _, p := range procs {
		if p.PID == c.pid {
			continue
		}
		isServer := c.isServerProcess(p) || (p.PID == pidFromFile && c.looksLikeServer(p))
		if !isServer {
			continue
		}
		if err := c.terminate(p.PID, processKillWait); err != nil {
			c.warnf("Could not stop pid %d: %v", p.PID, err)
		}
	}
	removeFile(c.pidFile())
}

// isServerProcess matches the server binaries Termote runs.
//
// Unix: the exact path with no arguments (a CLI invocation always has a
// subcommand), or, when the install dir is reached through a symlink, the
// resolved image path with an argument-free command line.
//
// Windows: only the image path is visible, so server\termote-server.exe is
// reserved for the server; the CLI runs from the release binary in the
// install root or, in a checkout, from server\termote-dev.exe.
func (c *cli) isServerProcess(p procInfo) bool {
	if c.goos == "windows" {
		return sameWindowsPath(p.Exe, c.serverBinary("native"))
	}
	paths := []string{c.serverBinary("native"), filepath.Join(c.projectDir, "server", "termote-dev")}
	if slices.Contains(paths, p.Cmdline) {
		return true
	}
	if p.Exe == "" {
		return false
	}
	last := p.Cmdline[strings.LastIndex(p.Cmdline, "/")+1:]
	for _, path := range paths {
		if resolved, err := filepath.EvalSymlinks(path); err == nil && resolved == p.Exe && last == filepath.Base(path) {
			return true
		}
	}
	return false
}

// sameWindowsPath compares paths the way NTFS does: case-insensitively, and
// across the 8.3 short and long forms of a directory (C:\Users\LAMNGO~1.KHU is
// what %TEMP% or a shim started from it can report, while the process image
// path is always the long form). Only same-named files reach the file-system
// check. Both sides carry the long file name: the process image path is
// always long, and the names compared against it are built here.
func sameWindowsPath(a, b string) bool {
	if strings.EqualFold(a, b) {
		return true
	}
	if a == "" || b == "" || !strings.EqualFold(filepath.Base(a), filepath.Base(b)) {
		return false
	}
	sa, err := os.Stat(a)
	if err != nil {
		return false
	}
	sb, err := os.Stat(b)
	return err == nil && os.SameFile(sa, sb)
}

// looksLikeServer guards the PID file against a reused PID.
func (c *cli) looksLikeServer(p procInfo) bool {
	name := p.Exe
	if name == "" {
		name, _, _ = strings.Cut(p.Cmdline, " ")
	}
	base := strings.TrimSuffix(strings.ToLower(filepath.Base(name)), ".exe")
	return strings.HasPrefix(base, "termote")
}

// stopContainers runs compose down in the install dir; purge also removes
// volumes and a leftover container, for uninstall.
func (c *cli) stopContainers(purge bool) {
	rt := c.containerRuntime()
	if rt == "" || !fileExists(filepath.Join(c.projectDir, "docker-compose.yml")) {
		return
	}
	args := []string{"compose", "--profile", "docker", "down"}
	if purge {
		args = append(args, "-v")
	}
	c.run.Output(c.projectDir, nil, rt, args...)
	if purge {
		c.run.Output(c.projectDir, nil, rt, "stop", containerName)
		c.run.Output(c.projectDir, nil, rt, "rm", containerName)
		removeFile(filepath.Join(c.projectDir, "docker-compose.override.yml"))
	}
}

// tailFile returns the last n lines of a file.
func tailFile(path string, n int) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return "(no log)"
	}
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

func (c *cli) cmdUninstall(args []string) error {
	pos, err := parseArgs(c.newFlagSet("uninstall"), args)
	if err != nil {
		return flagErr(err)
	}
	if len(pos) != 1 {
		return usageError("usage: termote uninstall <container|native|all>")
	}
	mode := pos[0]
	if mode == "docker" {
		mode = "container"
	}
	if mode != "container" && mode != "native" && mode != "all" {
		return usageError("unknown mode %q (use: container, native, all)", mode)
	}
	saved, _ := c.loadConfig()

	c.heading("Termote Uninstall (" + mode + ")")
	if mode == "container" || mode == "all" {
		c.infof("Stopping containers...")
		c.stopContainers(true)
		if c.goos == "windows" && saved != nil && saved.LAN && saved.Mode == "container" {
			port := saved.Port
			if port == 0 {
				port = c.defaultPort()
			}
			if err := c.runElevated(portProxyScript(port, false)); err != nil {
				c.warnf("Could not remove LAN port forwarding: %v", err)
			}
		}
	}
	if mode == "native" || mode == "all" {
		c.infof("Stopping native services...")
		c.stopNative()
	}
	// Reset Tailscale serve only when Termote configured it.
	if saved != nil && saved.Tailscale != "" {
		if _, err := c.run.LookPath("tailscale"); err == nil {
			c.infof("Resetting Tailscale serve...")
			name, args := c.tailscaleCmd("serve", "reset")
			c.run.Run("", nil, name, args...)
		}
	}
	if mode == "all" {
		removeFile(filepath.Join(c.projectDir, "server", "termote-dev"+c.exeSuffix()))
		if fileExists(c.configFile()) {
			c.infof("Removing saved config...")
			removeFile(c.configFile())
		}
	}
	fmt.Fprintln(c.out)
	c.infof("Uninstall complete!")
	return nil
}
