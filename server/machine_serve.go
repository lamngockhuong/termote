package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// newServeMachines is the server's machine manager: the machines of
// cfg.MachinesFile over SSH, or (only without a saved config, for the E2E
// suite) the bridges cfg.MachineBridges names, joined directly. nil when
// there is neither: no machine, no ssh.
func newServeMachines(cfg serveConfig, keepUp func() bool) *machineManager {
	var mm *machineManager
	switch {
	case cfg.MachineBridges != "":
		recs, d := parseMachineBridges(cfg.MachineBridges)
		if len(recs) == 0 {
			return nil
		}
		mm = newFixedMachineManager(recs, d)
	case cfg.MachinesFile != "":
		mm = newMachineManager(cfg.MachinesFile, newSSHDialer(sshPaths{
			Key:        filepath.Join(cfg.MachineSSHDir, "id_ed25519"),
			KnownHosts: filepath.Join(cfg.MachineSSHDir, "known_hosts"),
		}, cfg.MachineCtlDir))
	default:
		return nil
	}
	mm.keepUp = keepUp
	return mm
}

// newFixedMachineManager is a manager of recs that reload never changes.
func newFixedMachineManager(recs []machineRecord, d machineDialer) *machineManager {
	mm := &machineManager{dialer: d, fixed: recs, links: map[string]*machineLink{}, done: make(chan struct{})}
	mm.reload()
	go mm.janitor(machineJanitorEvery)
	return mm
}

// parseMachineBridges reads TERMOTE_E2E_MACHINE_BRIDGE: comma-separated
// <label>=<port>@<socket dir>, each the bridge of a server on this machine.
func parseMachineBridges(v string) ([]machineRecord, *socketDialer) {
	d := &socketDialer{targets: map[string]socketTarget{}}
	var recs []machineRecord
	for _, item := range strings.Split(v, ",") {
		label, rest, ok := strings.Cut(strings.TrimSpace(item), "=")
		portS, dir, ok2 := strings.Cut(rest, "@")
		port, err := strconv.Atoi(portS)
		if !ok || !ok2 || err != nil || validLabel(label) != nil || dir == "" {
			log.Printf("TERMOTE_E2E_MACHINE_BRIDGE: ignored %q", item)
			continue
		}
		sum := sha256.Sum256([]byte(label))
		id := hex.EncodeToString(sum[:8])
		recs = append(recs, machineRecord{ID: id, Label: label, Alias: label})
		d.targets[id] = socketTarget{dir: dir, port: port}
	}
	return recs, d
}

// socketDialer joins the bridge sockets of servers on this machine: what
// `termote bridge` does at the far end of ssh, without ssh.
type socketDialer struct {
	mu      sync.Mutex
	targets map[string]socketTarget
}

type socketTarget struct {
	dir  string
	port int
}

func (d *socketDialer) dial(_ context.Context, m machineRecord) (net.Conn, string, error) {
	d.mu.Lock()
	t, ok := d.targets[m.ID]
	d.mu.Unlock()
	if !ok {
		return nil, "", errMachineOffline
	}
	c, err := dialBridgeServer(t.dir, t.port)
	if err != nil {
		return nil, err.Error(), errMachineNoServer
	}
	return c, "", nil
}

func (d *socketDialer) idle(string)   {}
func (d *socketDialer) forget(string) {}
func (d *socketDialer) stop()         {}
