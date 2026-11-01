package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Parsers for the host stats sources of every OS, kept free of build tags so
// they are tested on every OS. Each takes bytes (or a directory, for sysfs)
// and returns values; nothing here runs a command.

var errSysFormat = errors.New("unexpected format")

// maxBatteryMinutes: a longer estimate is a rate read mid-change.
const maxBatteryMinutes = 48 * 60

// parseProcStat reads the aggregate "cpu" line of Linux /proc/stat: user
// nice system idle iowait irq softirq steal (guest time is already counted
// in user and nice). Idle and iowait are the idle share.
func parseProcStat(b []byte) (cpuTimes, error) {
	line, _, _ := bytes.Cut(b, []byte{'\n'})
	f := strings.Fields(string(line))
	if len(f) < 5 || f[0] != "cpu" {
		return cpuTimes{}, errSysFormat
	}
	var v [8]uint64
	for i := 0; i < len(v) && i+1 < len(f); i++ {
		n, err := strconv.ParseUint(f[i+1], 10, 64)
		if err != nil {
			return cpuTimes{}, errSysFormat
		}
		v[i] = n
	}
	var total uint64
	for _, n := range v {
		total += n
	}
	idle := v[3] + v[4]
	return cpuTimes{busy: total - idle, total: total, ok: true}, nil
}

// parseLoadavg reads the first three fields of Linux /proc/loadavg.
func parseLoadavg(b []byte) ([]float64, error) {
	f := strings.Fields(string(b))
	if len(f) < 3 {
		return nil, errSysFormat
	}
	load := make([]float64, 3)
	for i := range load {
		v, err := strconv.ParseFloat(f[i], 64)
		if err != nil {
			return nil, errSysFormat
		}
		load[i] = round2(v)
	}
	return load, nil
}

// parseMeminfo reads Linux /proc/meminfo. Used memory is MemTotal minus
// MemAvailable; a kernel without MemAvailable (before 3.14) gets
// MemFree + Buffers + Cached instead. swap is nil without swap.
func parseMeminfo(b []byte) (mem, swap *memStats, err error) {
	kb := map[string]uint64{}
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		name, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		f := strings.Fields(rest)
		if len(f) == 0 {
			continue
		}
		if v, err := strconv.ParseUint(f[0], 10, 64); err == nil {
			kb[name] = v * 1024
		}
	}
	total := kb["MemTotal"]
	if total == 0 {
		return nil, nil, errSysFormat
	}
	avail, ok := kb["MemAvailable"]
	if !ok {
		avail = kb["MemFree"] + kb["Buffers"] + kb["Cached"]
	}
	mem = newMemStats(total, total-min(avail, total), false)
	if st := kb["SwapTotal"]; st > 0 {
		swap = newMemStats(st, st-min(kb["SwapFree"], st), false)
	}
	return mem, swap, nil
}

// readPowerSupply reads the batteries under a Linux /sys/class/power_supply
// directory: entries whose type is Battery, skipping a device's own battery
// (scope Device: a mouse, a headset). Several batteries (BAT0 and BAT1) add
// up. nil without a battery; a missing directory is no error.
func readPowerSupply(dir string) (*batteryStats, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	read := func(name, file string) string {
		b, _ := os.ReadFile(filepath.Join(dir, name, file))
		return strings.TrimSpace(string(b))
	}
	num := func(name, file string) (uint64, bool) {
		v, err := strconv.ParseUint(read(name, file), 10, 64)
		return v, err == nil
	}
	var (
		found, charging, plugged bool
		capSum                   float64
		capN                     int
		now, full, rate          uint64
		haveEnergy, haveRate     = true, true
	)
	for _, n := range names {
		switch read(n, "type") {
		case "Mains", "USB", "USB_C", "USB_PD":
			if read(n, "online") == "1" {
				plugged = true
			}
			continue
		case "Battery":
		default:
			continue
		}
		if read(n, "scope") == "Device" {
			continue
		}
		found = true
		switch read(n, "status") {
		case "Charging":
			charging, plugged = true, true
		case "Full", "Not charging":
			plugged = true
		}
		if c, ok := num(n, "capacity"); ok {
			capSum += float64(min(c, 100))
			capN++
		}
		// Energy (µWh, µW) or charge (µAh, µA): one battery reports one pair.
		eNow, ok1 := num(n, "energy_now")
		eFull, ok2 := num(n, "energy_full")
		r, ok3 := num(n, "power_now")
		if !ok1 || !ok2 {
			eNow, ok1 = num(n, "charge_now")
			eFull, ok2 = num(n, "charge_full")
			r, ok3 = num(n, "current_now")
		}
		haveEnergy = haveEnergy && ok1 && ok2
		haveRate = haveRate && ok3
		now += eNow
		full += eFull
		rate += r
	}
	if !found {
		return nil, nil
	}
	b := &batteryStats{Charging: charging, Plugged: plugged}
	switch {
	case haveEnergy && full > 0:
		b.Percent = round1(min(float64(now)/float64(full)*100, 100))
	case capN > 0:
		b.Percent = round1(capSum / float64(capN))
	default:
		return nil, errSysFormat
	}
	if haveEnergy && haveRate && rate > 0 {
		left := now
		if charging {
			left = full - min(now, full)
		}
		// Right after a power change the rate reads a few µW: no estimate.
		if m := int(float64(left) / float64(rate) * 60); (charging || !plugged) && m <= maxBatteryMinutes {
			b.MinutesLeft = &m
		}
	}
	return b, nil
}

// containerMemory reads the memory limit of the cgroup at root (a
// container's /sys/fs/cgroup): cgroup v2 memory.max, memory.current and
// memory.stat, else v1 memory/memory.limit_in_bytes and usage_in_bytes.
// Used leaves out inactive file cache, which the kernel reclaims before the
// limit is hit (as `docker stats` counts it). nil without a limit below
// kernelTotal, or when the files cannot be read.
func containerMemory(root string, kernelTotal uint64) *memStats {
	read := func(name string) []byte {
		b, _ := os.ReadFile(filepath.Join(root, name))
		return b
	}
	if max := read("memory.max"); max != nil {
		return cgroupMemory(max, read("memory.current"), read("memory.stat"), "inactive_file", kernelTotal)
	}
	return cgroupMemory(read("memory/memory.limit_in_bytes"), read("memory/memory.usage_in_bytes"),
		read("memory/memory.stat"), "total_inactive_file", kernelTotal)
}

// cgroupMemory builds a container's memory from its limit, usage and
// memory.stat; inactive names the stat line of reclaimable file cache. A
// limit of "max" (v2) or one not below kernelTotal (v1's unlimited is about
// 2^63) is no limit: nil.
func cgroupMemory(limit, usage, stat []byte, inactive string, kernelTotal uint64) *memStats {
	parse := func(b []byte) (uint64, bool) {
		v, err := strconv.ParseUint(strings.TrimSpace(string(b)), 10, 64)
		return v, err == nil
	}
	total, ok1 := parse(limit)
	used, ok2 := parse(usage)
	if !ok1 || !ok2 || total == 0 || total >= kernelTotal {
		return nil
	}
	for _, line := range strings.Split(string(stat), "\n") {
		if name, v, ok := strings.Cut(line, " "); ok && name == inactive {
			if n, ok := parse([]byte(v)); ok {
				used -= min(n, used)
			}
			break
		}
	}
	m := newMemStats(total, used, false)
	m.Limit = true
	return m
}

// pmsetBattery matches the battery line of `pmset -g batt`:
// " -InternalBattery-0 (id=1234)	84%; charging; 1:23 remaining present: true".
var pmsetBattery = regexp.MustCompile(`(\d+)%;\s*([^;]+);\s*(.*)`)

// pmsetTime matches the "H:MM remaining" part.
var pmsetTime = regexp.MustCompile(`^(\d+):(\d{2}) remaining`)

// parsePmset reads `pmset -g batt`. nil without a battery line (a desktop
// Mac). Its states: "charging", "discharging", "charged", "finishing charge",
// "AC attached" (plugged, not charging); "(no estimate)" has no time.
func parsePmset(out []byte) *batteryStats {
	lines := strings.Split(string(out), "\n")
	plugged := len(lines) > 0 && strings.Contains(lines[0], "'AC Power'")
	for _, line := range lines[min(1, len(lines)):] {
		m := pmsetBattery.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		pct, _ := strconv.Atoi(m[1])
		state := strings.TrimSpace(m[2])
		b := &batteryStats{Percent: float64(min(pct, 100)), Plugged: plugged}
		switch state {
		case "charging", "finishing charge":
			b.Charging, b.Plugged = true, true
		case "charged", "AC attached":
			b.Plugged = true
		case "discharging":
			b.Plugged = false
		}
		if t := pmsetTime.FindStringSubmatch(strings.TrimSpace(m[3])); t != nil && (b.Charging || !b.Plugged) {
			h, _ := strconv.Atoi(t[1])
			mm, _ := strconv.Atoi(t[2])
			// "0:00 remaining" while discharging is pmset still estimating.
			if left := h*60 + mm; left > 0 {
				b.MinutesLeft = &left
			}
		}
		return b
	}
	return nil
}

// sumPsCPU adds up the %cpu column of `ps -A -o %cpu=` and divides it over
// ncpu cores; a process on several cores counts above 100.
func sumPsCPU(out []byte, ncpu int) (float64, error) {
	if ncpu <= 0 {
		return 0, errSysFormat
	}
	var sum float64
	n := 0
	for _, f := range strings.Fields(string(out)) {
		v, err := strconv.ParseFloat(strings.ReplaceAll(f, ",", "."), 64)
		if err != nil {
			return 0, errSysFormat
		}
		sum += v
		n++
	}
	if n == 0 {
		return 0, errSysFormat
	}
	return round1(min(sum/float64(ncpu), 100)), nil
}

// parseDarwinLoadavg reads the vm.loadavg sysctl: struct loadavg
// { fixpt_t ldavg[3]; long fscale; }, three uint32 then (after padding to 8)
// an int64 scale on 64-bit macOS.
func parseDarwinLoadavg(b []byte) ([]float64, error) {
	if len(b) < 24 {
		return nil, errSysFormat
	}
	scale := float64(binary.LittleEndian.Uint64(b[16:]))
	if scale <= 0 {
		return nil, errSysFormat
	}
	load := make([]float64, 3)
	for i := range load {
		load[i] = round2(float64(binary.LittleEndian.Uint32(b[i*4:])) / scale)
	}
	return load, nil
}

// parseXswUsage reads the vm.swapusage sysctl: struct xsw_usage
// { u_int64_t xsu_total, xsu_avail, xsu_used; ... }. nil without swap.
func parseXswUsage(b []byte) (*memStats, error) {
	if len(b) < 24 {
		return nil, errSysFormat
	}
	total := binary.LittleEndian.Uint64(b)
	used := binary.LittleEndian.Uint64(b[16:])
	return newMemStats(total, used, false), nil
}

// darwinMemory derives used memory from hw.memsize and
// kern.memorystatus_level (the share of memory the kernel counts as free):
// no sysctl gives Activity Monitor's figure, so it is marked approximate.
func darwinMemory(total uint64, level uint32) *memStats {
	if total == 0 || level > 100 {
		return nil
	}
	return newMemStats(total, total/100*uint64(100-level), true)
}

// windowsSwap derives swap from MEMORYSTATUSEX: the commit limit (page file
// fields) minus physical memory is the page file, and commit charge beyond
// physical use counts as used. Commit includes memory reserved but never
// touched, so the figure is marked approximate. nil without a page file.
func windowsSwap(totalPhys, availPhys, totalPage, availPage uint64) *memStats {
	if totalPage <= totalPhys {
		return nil
	}
	total := totalPage - totalPhys
	free := availPage - min(availPhys, availPage)
	return newMemStats(total, total-min(free, total), true)
}

// windowsBattery reads a SYSTEM_POWER_STATUS: BatteryFlag 128 is no battery,
// 255 an unknown status; a percent or lifetime of 255 / 0xFFFFFFFF is
// unknown. nil without a battery or a known percent.
func windowsBattery(acLine, flag, percent byte, lifeSeconds uint32) *batteryStats {
	if flag&128 != 0 || flag == 255 || percent > 100 {
		return nil
	}
	b := &batteryStats{Percent: float64(percent), Charging: flag&8 != 0, Plugged: acLine == 1}
	if lifeSeconds != 0xFFFFFFFF && !b.Plugged {
		m := int(lifeSeconds / 60)
		b.MinutesLeft = &m
	}
	return b
}
