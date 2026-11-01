package main

import (
	"math"
	"os"
	"runtime"
	"slices"
	"time"
)

// Host system stats: what the machine running termote has left (CPU, load,
// memory, swap, disk, battery), for the PWA's Host chip and sheet and for
// `termote status`. Each OS reads its own sources (system_<os>.go); the
// parsers are pure and live in system_parse.go so every OS tests them. A
// value the OS does not give is null, never 0. No path, command output or OS
// error text ever goes into these structs: they are sent to every signed-in
// device, view-only ones included.

// systemStats is one sample. Scope says whose numbers they are: "host" (this
// machine), "wsl" (the WSL virtual machine, whose memory and disk are its
// own) or "container" (the container's view, its battery never read).
type systemStats struct {
	Scope     string        `json:"scope"`
	CPU       *cpuStats     `json:"cpu"`
	Load      []float64     `json:"load"`
	Memory    *memStats     `json:"memory"`
	Swap      *memStats     `json:"swap"`
	Disks     []diskStats   `json:"disks"`
	Battery   *batteryStats `json:"battery"`
	SampledAt time.Time     `json:"sampledAt"`
}

// cpuStats: Percent is the busy share of all cores together (0-100).
type cpuStats struct {
	Percent float64 `json:"percent"`
	Count   int     `json:"count"`
}

// memStats is memory or swap in bytes. Approx marks a used figure the OS
// gives no exact source for (macOS memory); Limit marks a container's
// memory limit (cgroup) given as the total instead of the kernel's memory.
type memStats struct {
	Total   uint64  `json:"total"`
	Used    uint64  `json:"used"`
	Percent float64 `json:"percent"`
	Approx  bool    `json:"approx"`
	Limit   bool    `json:"limit"`
}

// diskStats is one filesystem. Label is a fixed word, never a path: "home"
// (the filesystem holding the home dir, where work lives) or "windows" (the
// Windows drive C: seen from WSL). Free is what this user may still write;
// Percent is the used share as df shows it.
type diskStats struct {
	Label   string  `json:"label"`
	Total   uint64  `json:"total"`
	Free    uint64  `json:"free"`
	Percent float64 `json:"percent"`
}

// batteryStats: Plugged is on external power (charging or not), MinutesLeft
// is to empty when discharging, to full when charging, null when the OS has
// no estimate.
type batteryStats struct {
	Percent     float64 `json:"percent"`
	Charging    bool    `json:"charging"`
	Plugged     bool    `json:"plugged"`
	MinutesLeft *int    `json:"minutesLeft"`
}

// cpuTimes are cumulative CPU counters; a percentage is the busy share of
// the difference between two samples. ok is false before the first read.
type cpuTimes struct {
	busy, total uint64
	ok          bool
}

// cpuPercent is the busy share between prev and cur, nil without two
// samples or with counters that did not move forward.
func cpuPercent(prev, cur cpuTimes) *cpuStats {
	if !prev.ok || !cur.ok || cur.total <= prev.total || cur.busy < prev.busy {
		return nil
	}
	p := float64(cur.busy-prev.busy) / float64(cur.total-prev.total) * 100
	return &cpuStats{Percent: round1(min(p, 100)), Count: runtime.NumCPU()}
}

// Scopes of a sample.
const (
	scopeHost      = "host"
	scopeWSL       = "wsl"
	scopeContainer = "container"
)

// systemScope says whose numbers this server reads: a container's (even
// under WSL), else the WSL VM's, else this machine's.
func systemScope() string {
	switch {
	case slices.ContainsFunc(containerMarkers, fileExists):
		return scopeContainer
	case onWSL(runtime.GOOS):
		return scopeWSL
	}
	return scopeHost
}

// Kinds of reading, for the errors a collector reports (logged once each).
const (
	sysCPU     = "cpu"
	sysLoad    = "load"
	sysMemory  = "memory"
	sysDisk    = "disk"
	sysBattery = "battery"
)

// sysErrors collects a sample's failed readings by kind; their text is only
// ever logged.
type sysErrors map[string]error

func (e sysErrors) add(kind string, err error) {
	if err != nil {
		if _, seen := e[kind]; !seen {
			e[kind] = err
		}
	}
}

// homeDisk measures the filesystem holding the home dir.
func homeDisk(errs sysErrors) []diskStats {
	home, err := os.UserHomeDir()
	if err != nil {
		errs.add(sysDisk, err)
		return nil
	}
	d, err := diskStatsOf(home, "home")
	if err != nil {
		errs.add(sysDisk, err)
		return nil
	}
	return []diskStats{d}
}

// newMemStats builds a memStats, nil when total is 0 (no swap, or nothing
// read).
func newMemStats(total, used uint64, approx bool) *memStats {
	if total == 0 {
		return nil
	}
	used = min(used, total)
	return &memStats{Total: total, Used: used, Percent: round1(float64(used) / float64(total) * 100), Approx: approx}
}

// newDiskStats builds a diskStats from a filesystem's total, free (for root)
// and available (for this user) bytes; the used share is df's:
// used / (used + available).
func newDiskStats(label string, total, free, avail uint64) diskStats {
	used := total - min(free, total)
	d := diskStats{Label: label, Total: total, Free: avail}
	if used+avail > 0 {
		d.Percent = round1(float64(used) / float64(used+avail) * 100)
	}
	return d
}

// round1 rounds to one decimal, so the JSON carries no noise digits.
func round1(f float64) float64 { return math.Round(f*10) / 10 }

// round2 rounds a load average to two decimals.
func round2(f float64) float64 { return math.Round(f*100) / 100 }
