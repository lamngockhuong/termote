package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// containerCLI is an installed release (not a checkout) with a fake docker.
// Its `docker run` checks the env file and starts a health endpoint on the
// published port, like the real container would.
type containerCLI struct {
	*testCLI
	runArgs []string
	envFile string
	envBody string
	envMode os.FileMode
	srv     *http.Server
}

func newContainerCLI(t *testing.T) *containerCLI {
	cc := &containerCLI{testCLI: newTestCLI(t, "linux")}
	cc.exe = filepath.Join(cc.versionsDir(), "1.0.0", "bin", "termote")
	cc.runner.paths["docker"] = true
	cc.runner.outputs["docker rm -f termote"] = ""
	cc.runner.onOutput = func(argv []string) (string, bool) {
		if len(argv) < 2 || argv[0] != "docker" || argv[1] != "run" {
			return "", false
		}
		cc.runArgs = argv
		if i := slices.Index(argv, "--env-file"); i > 0 {
			cc.envFile = argv[i+1]
			b, _ := os.ReadFile(cc.envFile)
			cc.envBody = string(b)
			if st, err := os.Stat(cc.envFile); err == nil {
				cc.envMode = st.Mode().Perm()
			}
		}
		port := strings.Split(argv[slices.Index(argv, "-p")+1], ":")[1]
		ln, err := net.Listen("tcp", "127.0.0.1:"+port)
		if err != nil {
			return "", false
		}
		cc.srv = &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprintf(w, `{"status":"ok","version":%q}`, cc.version)
		})}
		go cc.srv.Serve(ln)
		return "abc123\n", true
	}
	t.Cleanup(func() {
		if cc.srv != nil {
			cc.srv.Close()
		}
	})
	return cc
}

func TestContainerUpRunsTheReleaseImage(t *testing.T) {
	cc := newContainerCLI(t)
	cc.saveConfig(savedConfig{Port: 7690, Mux: "herdr", Password: "shared-pass", AllowHosts: []string{"native.lan"}})
	port := freePort(t)
	ws := filepath.Join(t.TempDir(), "ws")
	if code := cc.main([]string{"container", "up", "--port", strconv.Itoa(port), "--lan", "--allow-host", "c.lan", "--workspace", ws}); code != 0 {
		t.Fatalf("code %d\n%s%s", code, cc.stdout.String(), cc.stderr.String())
	}
	if !cc.runner.called("docker pull ghcr.io/lamngockhuong/termote:1.0.0") {
		t.Fatalf("image not pulled: %v", cc.runner.calls)
	}
	args := strings.Join(cc.runArgs, " ")
	for _, want := range []string{"--name termote", "--restart unless-stopped", fmt.Sprintf("-p 0.0.0.0:%d:7680", port),
		"-v " + ws + ":/workspace", "--user " + strconv.Itoa(os.Getuid()) + ":", "ghcr.io/lamngockhuong/termote:1.0.0"} {
		if !strings.Contains(args, want) {
			t.Errorf("run args miss %q: %s", want, args)
		}
	}
	if strings.Contains(args, "shared-pass") || strings.Contains(args, "TERMOTE_PASS") {
		t.Fatalf("password on the command line: %s", args)
	}
	if cc.envMode != 0o600 || !strings.Contains(cc.envBody, "TERMOTE_PASS=shared-pass\n") ||
		!strings.Contains(cc.envBody, "NO_AUTH=false\n") || !strings.Contains(cc.envBody, "c.lan") || !strings.Contains(cc.envBody, "192.168.1.20") {
		t.Fatalf("env file %v:\n%s", cc.envMode, cc.envBody)
	}
	if fileExists(cc.envFile) {
		t.Fatal("env file left behind")
	}
	if !isDir(ws) {
		t.Fatal("workspace not created")
	}
	// The container settings are saved apart; the native ones and the
	// shared password stay.
	cfg, _ := cc.loadConfig()
	if cfg.Port != 7690 || cfg.Mux != "herdr" || strings.Join(cfg.AllowHosts, ",") != "native.lan" || cfg.Password != "shared-pass" {
		t.Fatalf("native config changed: %+v", cfg)
	}
	if k := cfg.Container; k == nil || k.Port != port || !k.LAN || k.Workspace != ws || strings.Join(k.AllowHosts, ",") != "c.lan" {
		t.Fatalf("container config %+v", cfg.Container)
	}

	// A second up keeps the saved container settings; --lan=false turns one off.
	cc.srv.Close()
	cc.srv = nil
	cc.runArgs = nil
	if code := cc.main([]string{"container", "up", "--lan=false"}); code != 0 {
		t.Fatalf("second up: %s", cc.stderr.String())
	}
	if args := strings.Join(cc.runArgs, " "); !strings.Contains(args, fmt.Sprintf("-p 127.0.0.1:%d:7680", port)) || !strings.Contains(args, ws) {
		t.Fatalf("saved settings not reused: %s", args)
	}
}

func TestContainerUpRefusesBusyPort(t *testing.T) {
	cc := newContainerCLI(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	if code := cc.main([]string{"container", "up", "--port", strconv.Itoa(port)}); code != 1 || !strings.Contains(cc.stderr.String(), "--port") {
		t.Fatalf("code %d stderr %q", code, cc.stderr.String())
	}
	if cc.runArgs != nil {
		t.Fatal("container started on a busy port")
	}
}

func TestContainerUpBuildsFromCheckout(t *testing.T) {
	cc := newContainerCLI(t)
	cc.exe = filepath.Join(cc.projectDir, "server", "termote-dev")
	cc.version = cliVersion
	writeFile(t, filepath.Join(cc.projectDir, "pwa", "package.json"), "{}")
	writeFile(t, filepath.Join(cc.projectDir, "pwa", "dist", "index.html"), "<html>")
	writeFile(t, filepath.Join(cc.projectDir, "Dockerfile"), "FROM x")
	if code := cc.main([]string{"container", "up", "--port", strconv.Itoa(freePort(t)), "--no-auth"}); code != 0 {
		t.Fatalf("code %d %s", code, cc.stderr.String())
	}
	for _, want := range []string{"pnpm --filter termote build", "go build -ldflags=-s -w -o termote-linux-amd64 .", "docker build -t termote:local ."} {
		if !cc.runner.called(want) {
			t.Errorf("missing %q: %v", want, cc.runner.calls)
		}
	}
	if cc.runner.called("docker pull") || cc.runArgs[len(cc.runArgs)-1] != "termote:local" {
		t.Fatalf("checkout ran %v", cc.runArgs)
	}
	if !strings.Contains(cc.envBody, "NO_AUTH=true") || !strings.Contains(cc.envBody, "TERMOTE_PASS=\n") {
		t.Fatalf("no-auth env %q", cc.envBody)
	}

	release := newContainerCLI(t)
	if code := release.main([]string{"container", "up", "--build"}); code != 1 || !strings.Contains(release.stderr.String(), "checkout") {
		t.Fatalf("--build outside a checkout: %d %s", code, release.stderr.String())
	}
}

func TestContainerDownLogsStatus(t *testing.T) {
	cc := newContainerCLI(t)
	cc.runner.paths["tailscale"] = true
	cc.runner.outputs["tailscale serve --https=8443 off"] = ""
	cc.saveConfig(savedConfig{Password: "p", Tailscale: "native.ts.net", Container: &containerConfig{Port: 7681, Tailscale: "box.ts.net:8443"}})
	if code := cc.main([]string{"container", "down"}); code != 0 || !cc.runner.called("docker rm -f termote") {
		t.Fatalf("down: %d %v", code, cc.runner.calls)
	}
	// Only the container's mapping goes; the native one (443) stays.
	if !cc.runner.called("tailscale serve --https=8443 off") || cc.runner.called("tailscale serve --https=443 off") {
		t.Fatalf("tailscale calls %v", cc.runner.calls)
	}
	cc.main([]string{"container", "logs", "-f"})
	if !cc.runner.called("docker logs --tail 50 -f termote") {
		t.Fatalf("logs: %v", cc.runner.calls)
	}
	if code := cc.main([]string{"container", "status"}); code != 1 || !strings.Contains(cc.stdout.String(), "no container") {
		t.Fatalf("status without a container: %d\n%s", code, cc.stdout.String())
	}
	if code := cc.main([]string{"container", "bogus"}); code != 2 {
		t.Fatalf("unknown subcommand code %d", code)
	}
}
