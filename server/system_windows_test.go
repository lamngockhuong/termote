package main

import (
	"testing"
	"unsafe"
)

// The kernel32 structs must keep the C layouts.
func TestSystemWindowsStructSizes(t *testing.T) {
	if n := unsafe.Sizeof(memoryStatusEx{}); n != 64 {
		t.Errorf("MEMORYSTATUSEX is %d bytes, want 64", n)
	}
	if n := unsafe.Sizeof(systemPowerStatus{}); n != 12 {
		t.Errorf("SYSTEM_POWER_STATUS is %d bytes, want 12", n)
	}
}

func TestSystemWindowsCollect(t *testing.T) {
	s, cur, _ := collectSystem(scopeHost, cpuTimes{})
	if !cur.ok || s.Memory == nil || len(s.Disks) != 1 || s.Load != nil {
		t.Errorf("collect = %+v, cpu %+v", s, cur)
	}
}
