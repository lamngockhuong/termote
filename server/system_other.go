//go:build !linux && !darwin && !windows

package main

// collectSystem on other systems measures the home dir's disk only.
func collectSystem(scope string, prev cpuTimes) (systemStats, cpuTimes, sysErrors) {
	errs := sysErrors{}
	return systemStats{Scope: scope, Disks: homeDisk(errs)}, prev, errs
}
