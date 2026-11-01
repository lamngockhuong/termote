package main

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	procGetSystemTimes       = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetSystemTimes")
	procGlobalMemoryStatusEx = windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalMemoryStatusEx")
	procGetSystemPowerStatus = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetSystemPowerStatus")
)

// memoryStatusEx is MEMORYSTATUSEX (64 bytes).
type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

// systemPowerStatus is SYSTEM_POWER_STATUS (12 bytes).
type systemPowerStatus struct {
	ACLineStatus        byte
	BatteryFlag         byte
	BatteryLifePercent  byte
	SystemStatusFlag    byte
	BatteryLifeTime     uint32
	BatteryFullLifeTime uint32
}

// collectSystem reads one sample through kernel32. Windows has no load
// average, so Load stays nil. prev is the previous sample's CPU counters.
func collectSystem(scope string, prev cpuTimes) (systemStats, cpuTimes, sysErrors) {
	errs := sysErrors{}
	s := systemStats{Scope: scope}
	var cur cpuTimes
	var idle, kernel, user windows.Filetime
	if r, _, err := procGetSystemTimes.Call(uintptr(unsafe.Pointer(&idle)),
		uintptr(unsafe.Pointer(&kernel)), uintptr(unsafe.Pointer(&user))); r == 0 {
		errs.add(sysCPU, err)
	} else {
		// Kernel time includes the idle time.
		i, k, u := filetimeTicks(idle), filetimeTicks(kernel), filetimeTicks(user)
		total := k + u
		cur = cpuTimes{busy: total - min(i, total), total: total, ok: true}
		s.CPU = cpuPercent(prev, cur)
	}
	m := memoryStatusEx{Length: uint32(unsafe.Sizeof(memoryStatusEx{}))}
	if r, _, err := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&m))); r == 0 {
		errs.add(sysMemory, err)
	} else {
		s.Memory = newMemStats(m.TotalPhys, m.TotalPhys-min(m.AvailPhys, m.TotalPhys), false)
		s.Swap = windowsSwap(m.TotalPhys, m.AvailPhys, m.TotalPageFile, m.AvailPageFile)
	}
	s.Disks = homeDisk(errs)
	var p systemPowerStatus
	if r, _, err := procGetSystemPowerStatus.Call(uintptr(unsafe.Pointer(&p))); r == 0 {
		errs.add(sysBattery, err)
	} else {
		s.Battery = windowsBattery(p.ACLineStatus, p.BatteryFlag, p.BatteryLifePercent, p.BatteryLifeTime)
	}
	return s, cur, errs
}

func filetimeTicks(f windows.Filetime) uint64 {
	return uint64(f.HighDateTime)<<32 | uint64(f.LowDateTime)
}

// diskStatsOf measures the volume holding path.
func diskStatsOf(path, label string) (diskStats, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return diskStats{}, err
	}
	var avail, total, free uint64
	if err := windows.GetDiskFreeSpaceEx(p, &avail, &total, &free); err != nil {
		return diskStats{}, err
	}
	if total == 0 {
		return diskStats{}, errSysFormat
	}
	return newDiskStats(label, total, free, avail), nil
}
