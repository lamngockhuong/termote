package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// `termote serve` runs the server; it is what the service and the container
// entrypoint run. Without arguments the interactive menu opens; anything else
// is a CLI subcommand.
func main() {
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "serve" {
		os.Exit(runServe(args[1:]))
	}
	if len(args) == 0 {
		args = []string{"menu"}
	}
	os.Exit(runCLI(args))
}

// runServe reads the saved config (or, without one, the environment),
// removes every TERMOTE_* variable so no terminal inherits it, records its
// PID for stop and status, and serves until SIGTERM.
func runServe(args []string) int {
	service := false
	for _, a := range args {
		switch a {
		case "--service":
			// Started by the Windows task or Startup launcher.
			service = true
		default:
			fmt.Fprintf(os.Stderr, "[ERROR] serve takes no arguments but --service; settings come from 'termote start'\n")
			return 2
		}
	}
	if service {
		hideConsole()
	}
	c, err := newCLI()
	if err != nil {
		fmt.Fprintf(os.Stderr, "[ERROR] %v\n", err)
		return 1
	}
	cfg, err := c.loadServeConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "[ERROR] %v\n", err)
		if errors.Is(err, errConfigUnusable) {
			// launchd's KeepAlive restarts any failed exit every few
			// seconds; exit 0 so only `termote start --fresh` runs it again.
			if os.Getenv("XPC_SERVICE_NAME") == launchdLabel {
				return 0
			}
			return exitConfigUnusable
		}
		return 1
	}
	scrubTermoteEnv()
	serverInstall = c.installKind()
	cfg.FilesDenyDirs = filesDenyDirs(c.configDir(), c.stateDir())
	cfg.FilesWriteDenyDirs = []string{c.dataDir()}
	cfg.UploadDir = uploadDir()
	cfg.TrashDir = trashDir()
	// Under the state dir, which FilesDenyDirs already keeps from the Files
	// view, and which does not roam on Windows (a private key).
	cfg.PushDir = filepath.Join(c.stateDir(), "push")
	cfg.OnListen = func() {
		if err := c.writePIDFile(); err != nil {
			fmt.Fprintf(os.Stderr, "[WARN] cannot write %s: %v\n", c.pidFile(), err)
		}
	}
	defer c.removePIDFile()
	startServeMode(cfg)
	return 0
}
