package main

import (
	"encoding/base64"
	"errors"
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

// containerOptions are the flags of container up.
type containerOptions struct {
	lan        bool
	noAuth     bool
	fresh      bool
	port       int
	tailscale  string
	allowHosts []string
}

func (c *cli) cmdContainer(args []string) error {
	if len(args) == 0 {
		return usageError("usage: termote container <up|down> [options]")
	}
	switch args[0] {
	case "up":
		return c.containerUp(args[1:])
	case "down":
		return c.containerDown(args[1:])
	}
	return usageError("unknown container command %q (use: up, down)", args[0])
}

// containerUp builds and runs the image with compose from a checkout.
func (c *cli) containerUp(args []string) error {
	var o containerOptions
	var hosts stringList
	fs := c.newFlagSet("container up")
	fs.BoolVar(&o.lan, "lan", false, "")
	fs.BoolVar(&o.noAuth, "no-auth", false, "")
	fs.BoolVar(&o.fresh, "fresh", false, "")
	fs.IntVar(&o.port, "port", containerPort, "")
	fs.StringVar(&o.tailscale, "tailscale", "", "")
	fs.Var(&hosts, "allow-host", "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	if len(pos) > 0 {
		return usageError("container up takes no arguments, only options")
	}
	o.allowHosts = hosts
	if o.port < 1 || o.port > 65535 {
		return usageError("invalid port: %d", o.port)
	}
	for _, h := range o.allowHosts {
		if err := validateHostName(h); err != nil {
			return usageError("%v", err)
		}
	}
	if o.tailscale != "" {
		if err := validTailscale(o.tailscale); err != nil {
			return usageError("%v", err)
		}
	}
	if c.containerRuntime() == "" {
		return errors.New("neither podman nor docker found; install one")
	}
	if !c.isCheckout() || !fileExists(filepath.Join(c.projectDir, "docker-compose.yml")) {
		return errors.New("container up needs a git checkout for now (it builds the image from the Dockerfile)")
	}
	saved, err := c.loadConfig()
	if err != nil {
		return err
	}
	pass := ""
	if !o.noAuth {
		if saved != nil && saved.Password != "" && !o.fresh {
			pass = saved.Password
		} else if pass, err = generatePassword(); err != nil {
			return err
		}
	}
	c.heading("Termote Container")
	c.stopContainers(false)
	if err := c.setupPWA(false); err != nil {
		return err
	}
	if err := c.buildImageBinary(); err != nil {
		return err
	}
	hosts = computeAllowedHosts(o.lan, o.tailscale, o.allowHosts, c.localIPv4s())
	if err := c.startContainer(o, pass, hosts); err != nil {
		return err
	}
	if o.tailscale != "" {
		if err := c.setupTailscale(o.tailscale, o.port); err != nil {
			c.warnf("%v", err)
		}
	}
	if pass != "" && (saved == nil || saved.Password != pass) {
		cfg := savedConfig{}
		if saved != nil {
			cfg = *saved
		}
		cfg.Password = pass
		if err := c.saveConfig(cfg); err != nil {
			c.warnf("Could not save the password: %v", err)
		}
		c.showCredentials(pass)
	}
	c.infof("Container running: http://localhost:%d", o.port)
	return nil
}

func (c *cli) containerDown(args []string) error {
	if _, err := parseArgs(c.newFlagSet("container down"), args); err != nil {
		return flagErr(err)
	}
	c.infof("Stopping the container...")
	c.stopContainers(true)
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

func (c *cli) startContainer(o containerOptions, pass string, hosts []string) error {
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
	if err := c.waitForServer(o.port, pass, "", containerStartWait, nil); err != nil {
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

// stopContainers runs compose down in the checkout; purge also removes
// volumes and a leftover container.
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
