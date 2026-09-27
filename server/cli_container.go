package main

import (
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"net"
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

// containerImage is the published image `container up` runs; its tag is the
// version of this binary, so the CLI and the server inside always match.
const containerImage = "ghcr.io/lamngockhuong/termote"

// localImage is the tag `container up --build` gives an image built from a
// checkout.
const localImage = "termote:local"

// containerStartWait bounds the wait for a freshly started container (an
// image pull happens before it, so this is only the server's start).
var containerStartWait = 30 * time.Second

// containerOptions are the flags of container up after merging the saved
// container settings.
type containerOptions struct {
	lan         bool
	noAuth      bool
	fresh       bool
	build       bool
	port        int
	tailscale   string
	noTailscale bool
	workspace   string
	allowHosts  []string
	removeHosts []string
}

func (c *cli) cmdContainer(args []string) error {
	if len(args) == 0 {
		return usageError("usage: termote container <up|down|logs|status> [options]")
	}
	switch args[0] {
	case "up":
		return c.containerUp(args[1:])
	case "down":
		return c.containerDown(args[1:])
	case "logs":
		return c.containerLogs(args[1:])
	case "status":
		return c.containerStatus(args[1:])
	}
	return usageError("unknown container command %q (use: up, down, logs, status)", args[0])
}

func (c *cli) parseContainerArgs(args []string) (containerOptions, map[string]bool, error) {
	var o containerOptions
	var hosts, remove stringList
	fs := c.newFlagSet("container up")
	fs.BoolVar(&o.lan, "lan", false, "")
	fs.BoolVar(&o.noAuth, "no-auth", false, "")
	fs.BoolVar(&o.fresh, "fresh", false, "")
	fs.BoolVar(&o.build, "build", false, "")
	fs.IntVar(&o.port, "port", 0, "")
	fs.StringVar(&o.tailscale, "tailscale", "", "")
	fs.BoolVar(&o.noTailscale, "no-tailscale", false, "")
	fs.StringVar(&o.workspace, "workspace", "", "")
	fs.Var(&hosts, "allow-host", "")
	fs.Var(&remove, "remove-host", "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return o, nil, flagErr(err)
	}
	if len(pos) > 0 {
		return o, nil, usageError("container up takes no arguments, only options (see: termote help)")
	}
	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	if set["tailscale"] && o.noTailscale {
		return o, nil, usageError("--tailscale and --no-tailscale cannot be combined")
	}
	o.allowHosts, o.removeHosts = hosts, remove
	return o, set, nil
}

// mergeContainer applies the saved container settings to every flag not
// given, like mergeSaved does for the native server.
func (c *cli) mergeContainer(o *containerOptions, set map[string]bool, s *containerConfig) error {
	if s == nil {
		s = &containerConfig{}
	}
	if !set["lan"] {
		o.lan = s.LAN
	}
	if !set["no-auth"] {
		o.noAuth = s.NoAuth
	}
	if !set["port"] {
		o.port = s.Port
	}
	if !set["tailscale"] && !o.noTailscale {
		o.tailscale = s.Tailscale
	}
	if !set["workspace"] {
		o.workspace = s.Workspace
	}
	for _, h := range s.AllowHosts {
		if !slices.Contains(o.allowHosts, h) {
			o.allowHosts = append(o.allowHosts, h)
		}
	}
	o.allowHosts = slices.DeleteFunc(o.allowHosts, func(h string) bool {
		return slices.ContainsFunc(o.removeHosts, func(r string) bool { return strings.EqualFold(r, h) })
	})
	slices.Sort(o.allowHosts)

	if o.port == 0 {
		o.port = containerPort
	}
	if o.port < 1 || o.port > 65535 {
		return usageError("invalid port: %d", o.port)
	}
	for _, h := range append(slices.Clone(o.allowHosts), o.removeHosts...) {
		if err := validateHostName(h); err != nil {
			return usageError("%v", err)
		}
	}
	if o.tailscale != "" {
		if err := validTailscale(o.tailscale); err != nil {
			return usageError("%v", err)
		}
	}
	if o.workspace == "" {
		o.workspace = filepath.Join(c.home, "termote-workspace")
	}
	if !filepath.IsAbs(o.workspace) {
		abs, err := filepath.Abs(o.workspace)
		if err != nil {
			return err
		}
		o.workspace = abs
	}
	if strings.ContainsAny(o.workspace, "\"\n\r,") {
		return usageError("invalid --workspace %q", o.workspace)
	}
	return nil
}

// containerUp runs the image for this version (or, from a checkout, one
// built from its Dockerfile) with the saved container settings.
func (c *cli) containerUp(args []string) error {
	o, set, err := c.parseContainerArgs(args)
	if err != nil {
		return err
	}
	saved, err := c.loadConfig()
	if err != nil {
		return fmt.Errorf("cannot read %s (%v); fix or delete it, then run again", c.configFile(), err)
	}
	var prev *containerConfig
	if saved != nil {
		prev = saved.Container
	}
	if err := c.mergeContainer(&o, set, prev); err != nil {
		return err
	}
	rt := c.containerRuntime()
	if rt == "" {
		return errors.New("neither podman nor docker found; install one")
	}
	build := o.build || c.isCheckout()
	if build && !fileExists(filepath.Join(c.projectDir, "Dockerfile")) {
		return errors.New("--build needs a git checkout (it builds the image from its Dockerfile)")
	}
	pass, reused, err := c.setupAuth(startOptions{noAuth: o.noAuth, fresh: o.fresh}, saved)
	if err != nil {
		return err
	}

	c.heading("Termote Container")
	image := containerImage + ":" + c.version
	if build {
		image = localImage
		if err := c.buildImage(rt); err != nil {
			return err
		}
	} else {
		c.infof("Pulling %s...", image)
		if err := c.run.Run("", nil, rt, "pull", image); err != nil {
			return fmt.Errorf("cannot pull %s (%v); a pre-release has no image until it is published", image, err)
		}
	}

	// Replace the old container, then check the port is free for the new.
	c.run.Output("", nil, rt, "rm", "-f", containerName)
	bind := "127.0.0.1"
	if o.lan && c.goos != "windows" {
		bind = "0.0.0.0" // Windows maps to localhost; LAN goes through portproxy
	}
	if err := portFree(bind, o.port); err != nil {
		return fmt.Errorf("port %d is in use (%v); is the native server running? Choose another with --port", o.port, err)
	}
	c.warnSensitiveDirs(o.workspace)
	// Docker Desktop does not create a missing bind-mount source, and Docker
	// on Linux would create it owned by root.
	if err := ensureDir(o.workspace); err != nil {
		return err
	}
	if prev != nil && prev.Tailscale != "" && prev.Tailscale != o.tailscale {
		c.removeTailscale(prev.Tailscale)
	}
	hosts := computeAllowedHosts(o.lan, o.tailscale, o.allowHosts, c.localIPv4s())
	if err := c.runContainer(rt, image, bind, o, pass, hosts); err != nil {
		return err
	}

	cfg := savedConfig{}
	if saved != nil {
		cfg = *saved
	}
	cfg.Password = pass
	cfg.Container = &containerConfig{LAN: o.lan, NoAuth: o.noAuth, Port: o.port, Tailscale: o.tailscale, AllowHosts: o.allowHosts, Workspace: o.workspace}
	if err := c.saveConfig(cfg); err != nil {
		c.warnf("Could not save the container settings: %v", err)
	}
	if o.lan && c.goos == "windows" {
		c.setupPortProxy(o.port)
	}
	if o.tailscale != "" {
		// The server runs in the container, so no serve re-applies this at
		// boot; tailscaled keeps a --bg mapping across reboots itself.
		if err := c.setupTailscale(o.tailscale, o.port); err != nil {
			c.warnf("%v", err)
		}
	}
	version := c.version
	if build {
		version = cliVersion
	}
	if err := c.waitForServer(o.port, pass, version, containerStartWait, nil); err != nil {
		return fmt.Errorf("the container started but the server does not answer (%v); see: termote container logs", err)
	}
	if rt == "podman" && c.goos == "linux" {
		c.infof("Podman has no daemon to restart the container after a reboot; to keep it, run it as a Quadlet unit (see: https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html)")
	}
	c.infof("Container running (%s, image %s)", rt, image)
	c.showAccessInfo(startOptions{lan: o.lan, noAuth: o.noAuth, port: o.port, tailscale: o.tailscale, mux: "tmux", allowHosts: o.allowHosts}, pass, reused)
	// One password for both: a new one also changes the native server's.
	if !reused && pass != "" && saved != nil && saved.Password != "" {
		c.infof("The native server shares this new password; it takes it at its next restart (termote restart)")
	}
	return nil
}

// runContainer starts the container. The password and settings go in an
// env file readable by this user only and removed right after, so they are
// never on a command line (ps shows those to every user).
func (c *cli) runContainer(rt, image, bind string, o containerOptions, pass string, hosts []string) error {
	// CreateTemp makes the file 0600.
	env, err := os.CreateTemp("", "termote-env-")
	if err != nil {
		return err
	}
	defer os.Remove(env.Name())
	fmt.Fprintf(env, "NO_AUTH=%t\nTERMOTE_PASS=%s\nTERMOTE_ALLOWED_HOSTS=%s\n", o.noAuth, pass, strings.Join(hosts, ","))
	if err := env.Close(); err != nil {
		return err
	}
	args := []string{"run", "-d", "--name", containerName, "--restart", "unless-stopped",
		"-p", fmt.Sprintf("%s:%d:%d", bind, o.port, containerPort),
		"-v", o.workspace + ":/workspace", "-w", "/workspace", "--env-file", env.Name()}
	if uid, gid := os.Getuid(), os.Getgid(); uid >= 0 && gid >= 0 {
		args = append(args, "--user", strconv.Itoa(uid)+":"+strconv.Itoa(gid))
	}
	if _, err := c.run.Output("", nil, rt, append(args, image)...); err != nil {
		return fmt.Errorf("%s run %s: %w", rt, image, err)
	}
	return nil
}

// buildImage builds the image from the checkout: the PWA, then the Linux
// binary that embeds it, then the Dockerfile.
func (c *cli) buildImage(rt string) error {
	if err := c.setupPWA(false); err != nil {
		return err
	}
	if err := c.buildImageBinary(); err != nil {
		return err
	}
	c.infof("Building the image %s...", localImage)
	if err := c.run.Run(c.projectDir, nil, rt, "build", "-t", localImage, "."); err != nil {
		return fmt.Errorf("%s build: %w", rt, err)
	}
	return nil
}

// buildImageBinary compiles the Linux binary the Dockerfile copies, with the
// PWA build embedded.
func (c *cli) buildImageBinary() error {
	name := "termote-linux-" + c.goarch
	c.infof("Building the server (linux/%s)...", c.goarch)
	env := environ(map[string]string{"CGO_ENABLED": "0", "GOOS": "linux", "GOARCH": c.goarch})
	if err := c.run.Run(filepath.Join(c.projectDir, "server"), env, "go", "build", "-ldflags=-s -w", "-o", name, "."); err != nil {
		return fmt.Errorf("build server: %w", err)
	}
	return nil
}

func (c *cli) containerDown(args []string) error {
	if _, err := parseArgs(c.newFlagSet("container down"), args); err != nil {
		return flagErr(err)
	}
	rt := c.containerRuntime()
	if rt == "" {
		return errors.New("neither podman nor docker found")
	}
	if _, err := c.run.Output("", nil, rt, "rm", "-f", containerName); err != nil {
		c.infof("No container named %s", containerName)
	} else {
		c.infof("Container removed")
	}
	saved, _ := c.loadConfig()
	if saved != nil && saved.Container != nil {
		c.removeTailscale(saved.Container.Tailscale)
		if saved.Container.LAN && c.goos == "windows" {
			if err := c.runElevated(portProxyScript(saved.Container.Port, false)); err != nil {
				c.warnf("Could not remove LAN port forwarding: %v", err)
			}
		}
	}
	return nil
}

func (c *cli) containerLogs(args []string) error {
	var follow bool
	fs := c.newFlagSet("container logs")
	fs.BoolVar(&follow, "f", false, "")
	fs.BoolVar(&follow, "follow", false, "")
	if _, err := parseArgs(fs, args); err != nil {
		return flagErr(err)
	}
	rt := c.containerRuntime()
	if rt == "" {
		return errors.New("neither podman nor docker found")
	}
	a := []string{"logs", "--tail", strconv.Itoa(defaultLogLines)}
	if follow {
		a = append(a, "-f")
	}
	return c.run.Run("", nil, rt, append(a, containerName)...)
}

func (c *cli) containerStatus(args []string) error {
	if _, err := parseArgs(c.newFlagSet("container status"), args); err != nil {
		return flagErr(err)
	}
	rt := c.containerRuntime()
	if rt == "" {
		return errors.New("neither podman nor docker found")
	}
	c.heading("Termote Container")
	out, err := c.run.Output("", nil, rt, "ps", "-a", "--filter", "name=^"+containerName+"$", "--format", "{{.Status}}\t{{.Image}}")
	state := strings.TrimSpace(string(out))
	if err != nil || state == "" {
		fmt.Fprintf(c.out, "  %s no container (run: termote container up)\n\n", c.paint(ansiRed, "[--]"))
		return &exitError{code: 1}
	}
	status, image, _ := strings.Cut(state, "\t")
	fmt.Fprintf(c.out, "  Runtime: %s\n  Image: %s\n  State: %s\n", rt, image, status)
	saved, _ := c.loadConfig()
	if saved == nil || saved.Container == nil {
		fmt.Fprintln(c.out)
		return nil
	}
	port := saved.Container.Port
	pass := ""
	if !saved.Container.NoAuth {
		pass = saved.Password
	}
	h, code := fetchHealth(port, pass)
	if code == 200 {
		fmt.Fprintf(c.out, "  %s server :%d - %s (v%s)\n\n", c.paint(ansiGreen, "[OK]"), port, h.Status, h.Version)
		return nil
	}
	fmt.Fprintf(c.out, "  %s server :%d - %s\n\n", c.paint(ansiRed, "[--]"), port, describeCode(code))
	return &exitError{code: 1}
}

// describeCode names an HTTP status from fetchHealth.
func describeCode(code int) string {
	switch code {
	case 0:
		return "not answering"
	case 401:
		return "running (the saved password was not accepted)"
	}
	return "HTTP " + strconv.Itoa(code)
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

// computeAllowedHosts is the container's TERMOTE_ALLOWED_HOSTS: LAN
// addresses with --lan, the Tailscale name and the --allow-host names. The
// server always adds loopback. (A native server checks its own local address
// instead of a LAN list.)
func computeAllowedHosts(lan bool, ts string, allowHosts, lanIPs []string) []string {
	var hosts []string
	add := func(h string) {
		h = strings.ToLower(h)
		if h != "" && !slices.Contains(hosts, h) {
			hosts = append(hosts, h)
		}
	}
	if lan {
		for _, ip := range lanIPs {
			add(ip)
		}
	}
	if ts != "" {
		host, _ := splitTailscale(ts)
		add(host)
	}
	for _, h := range allowHosts {
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

// containerRuntime prefers podman, the lighter of the two.
func (c *cli) containerRuntime() string {
	for _, rt := range []string{"podman", "docker"} {
		if _, err := c.run.LookPath(rt); err == nil {
			return rt
		}
	}
	return ""
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
