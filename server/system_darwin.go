package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"time"

	"golang.org/x/sys/unix"
)

// collectSystem reads one sample from sysctl, `ps` and `pmset`. macOS has no
// cumulative CPU counters without cgo, so the CPU share is ps's per-process
// %cpu summed over the cores and prev is unused.
func collectSystem(scope string, prev cpuTimes) (systemStats, cpuTimes, sysErrors) {
	errs := sysErrors{}
	s := systemStats{Scope: scope}
	if out, err := runSysCommand("ps", "-A", "-o", "%cpu="); err != nil {
		errs.add(sysCPU, err)
	} else if p, err := sumPsCPU(out, runtime.NumCPU()); err != nil {
		errs.add(sysCPU, err)
	} else {
		s.CPU = &cpuStats{Percent: p, Count: runtime.NumCPU()}
	}
	if b, err := unix.SysctlRaw("vm.loadavg"); err != nil {
		errs.add(sysLoad, err)
	} else if s.Load, err = parseDarwinLoadavg(b); err != nil {
		errs.add(sysLoad, err)
	}
	total, err1 := unix.SysctlUint64("hw.memsize")
	level, err2 := unix.SysctlUint32("kern.memorystatus_level")
	if err := errors.Join(err1, err2); err != nil {
		errs.add(sysMemory, err)
	} else {
		s.Memory = darwinMemory(total, level)
	}
	if b, err := unix.SysctlRaw("vm.swapusage"); err != nil {
		errs.add(sysMemory, err)
	} else if s.Swap, err = parseXswUsage(b); err != nil {
		errs.add(sysMemory, err)
	}
	// The home dir is on the APFS data volume; / is the sealed system one.
	s.Disks = homeDisk(errs)
	if out, err := runSysCommand("pmset", "-g", "batt"); err != nil {
		errs.add(sysBattery, err)
	} else {
		s.Battery = parsePmset(out)
	}
	return s, prev, errs
}

// runSysCommand runs a stats command by argv in the C locale (a decimal
// point, English pmset states), giving up after 2 s.
func runSysCommand(name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	return cmd.Output()
}
