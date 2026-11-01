package main

import "os"

// collectSystem reads one sample from /proc and /sys. prev is the previous
// sample's CPU counters (the first sample has no CPU share).
func collectSystem(scope string, prev cpuTimes) (systemStats, cpuTimes, sysErrors) {
	errs := sysErrors{}
	s := systemStats{Scope: scope}
	var cur cpuTimes
	if b, err := os.ReadFile("/proc/stat"); err != nil {
		errs.add(sysCPU, err)
	} else if cur, err = parseProcStat(b); err != nil {
		errs.add(sysCPU, err)
	} else {
		s.CPU = cpuPercent(prev, cur)
	}
	if b, err := os.ReadFile("/proc/loadavg"); err != nil {
		errs.add(sysLoad, err)
	} else if s.Load, err = parseLoadavg(b); err != nil {
		errs.add(sysLoad, err)
	}
	if b, err := os.ReadFile("/proc/meminfo"); err != nil {
		errs.add(sysMemory, err)
	} else if s.Memory, s.Swap, err = parseMeminfo(b); err != nil {
		errs.add(sysMemory, err)
	}
	// /proc/meminfo in a container is the kernel's; a memory limit on the
	// container (its own cgroup, the root of its namespace) is what it runs
	// out of.
	if scope == scopeContainer && s.Memory != nil {
		if m := containerMemory("/sys/fs/cgroup", s.Memory.Total); m != nil {
			s.Memory = m
		}
	}
	s.Disks = homeDisk(errs)
	// Under WSL the Linux disk is a virtual one; the Windows drive is where
	// space actually runs out.
	if scope == scopeWSL && isDir("/mnt/c") {
		if d, err := diskStatsOf("/mnt/c", "windows"); err == nil {
			s.Disks = append(s.Disks, d)
		} else {
			errs.add(sysDisk, err)
		}
	}
	// A container's /sys is the VM's or the host's: its battery is not read.
	if scope != scopeContainer {
		b, err := readPowerSupply("/sys/class/power_supply")
		errs.add(sysBattery, err)
		s.Battery = b
	}
	return s, cur, errs
}
