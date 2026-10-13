package main

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"time"
)

// procEnviron is pid's environment from kern.procargs2.
func procEnviron(pid int) ([]string, bool) {
	_, _, env, ok := procArgs2(pid)
	return env, ok
}

// zellijSocketOwner finds the process of this user holding a socket named
// path, through lsof (which names a socket by the path it was bound to: a
// session renamed since is not found).
func zellijSocketOwner(path string) (int, error) {
	if fi, err := os.Lstat(path); err != nil || fi.Mode()&os.ModeSocket == 0 {
		return 0, errZellijServerNotFound
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "lsof", "-w", "-n", "-U", "-a", "-u", strconv.Itoa(os.Getuid()), "-Fpn").Output()
	if err != nil && len(out) == 0 {
		return 0, errZellijServerNotFound
	}
	var servers []int
	for _, pid := range parseLsofUnixOwners(string(out), path) {
		if args := procArgs(pid); len(args) >= 2 && args[1] == "--server" {
			servers = append(servers, pid)
		}
	}
	if len(servers) != 1 {
		return 0, errZellijServerNotFound
	}
	return servers[0], nil
}
