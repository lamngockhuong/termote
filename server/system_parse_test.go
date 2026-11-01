package main

import (
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func systemFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "system", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestProcStatDelta(t *testing.T) {
	a, err := parseProcStat(systemFixture(t, "proc_stat_a"))
	if err != nil {
		t.Fatal(err)
	}
	b, err := parseProcStat(systemFixture(t, "proc_stat_b"))
	if err != nil {
		t.Fatal(err)
	}
	// a: total 1000, idle 850; b: total 1160, idle 920 -> busy 90 of 160.
	if a.total != 1000 || a.busy != 150 || b.total != 1160 || b.busy != 240 {
		t.Fatalf("a = %+v, b = %+v", a, b)
	}
	c := cpuPercent(a, b)
	if c == nil || c.Percent != 56.3 || c.Count <= 0 {
		t.Errorf("cpu = %+v, want 56.3%%", c)
	}
	if cpuPercent(cpuTimes{}, b) != nil {
		t.Error("first sample has a CPU share")
	}
	if cpuPercent(b, a) != nil {
		t.Error("counters going back give a share")
	}
	for _, bad := range []string{"", "intr 1\n", "cpu x y z w\n"} {
		if _, err := parseProcStat([]byte(bad)); err == nil {
			t.Errorf("parseProcStat(%q) = nil error", bad)
		}
	}
}

func TestSystemProcLoadavg(t *testing.T) {
	load, err := parseLoadavg([]byte("1.234 0.50 0.05 2/345 6789\n"))
	if err != nil || !reflect.DeepEqual(load, []float64{1.23, 0.5, 0.05}) {
		t.Errorf("load = %v, %v", load, err)
	}
	if _, err := parseLoadavg([]byte("1.0\n")); err == nil {
		t.Error("short loadavg parsed")
	}
}

func TestMeminfo(t *testing.T) {
	mem, swap, err := parseMeminfo(systemFixture(t, "meminfo_wsl"))
	if err != nil {
		t.Fatal(err)
	}
	if mem.Total != 16303452*1024 || mem.Used != (16303452-14100000)*1024 || mem.Approx {
		t.Errorf("mem = %+v", mem)
	}
	if swap == nil || swap.Total != 4194304*1024 || swap.Used != 1048576*1024 || swap.Percent != 25 {
		t.Errorf("swap = %+v", swap)
	}

	mem, swap, err = parseMeminfo(systemFixture(t, "meminfo_noswap"))
	if err != nil || swap != nil || mem.Percent != 75 {
		t.Errorf("no swap: mem %+v swap %+v err %v", mem, swap, err)
	}

	// Without MemAvailable: MemFree + Buffers + Cached.
	mem, _, err = parseMeminfo(systemFixture(t, "meminfo_old"))
	if err != nil || mem.Used != 5000000*1024 {
		t.Errorf("old kernel: mem %+v err %v", mem, err)
	}

	if _, _, err := parseMeminfo([]byte("Foo: 1 kB\n")); err == nil {
		t.Error("meminfo without MemTotal parsed")
	}
}

func TestPowerSupply(t *testing.T) {
	dir := func(n string) string { return filepath.Join("testdata", "system", n) }
	minutes := func(b *batteryStats) any {
		if b.MinutesLeft == nil {
			return nil
		}
		return *b.MinutesLeft
	}

	b, err := readPowerSupply(dir("power_supply_discharging"))
	if err != nil || b == nil || b.Percent != 50 || b.Charging || b.Plugged || minutes(b) != 120 {
		t.Errorf("discharging = %+v (%v) err %v", b, minutes(b), err)
	}

	// BAT0 and BAT1 add up: 50 of 75 Wh; charging needs 25 Wh at 20 W.
	b, err = readPowerSupply(dir("power_supply_two"))
	if err != nil || b == nil || b.Percent != 66.7 || !b.Charging || !b.Plugged || minutes(b) != 75 {
		t.Errorf("two = %+v (%v) err %v", b, minutes(b), err)
	}

	// Charge files, a battery named "battery", full and idle: no time.
	b, err = readPowerSupply(dir("power_supply_charge"))
	if err != nil || b == nil || b.Percent != 100 || b.Charging || !b.Plugged || b.MinutesLeft != nil {
		t.Errorf("charge = %+v err %v", b, err)
	}

	b, err = readPowerSupply(dir("power_supply_capacity_only"))
	if err != nil || b == nil || b.Percent != 73 || b.MinutesLeft != nil {
		t.Errorf("capacity only = %+v err %v", b, err)
	}

	// Only AC and a mouse's battery: no battery of this machine.
	b, err = readPowerSupply(dir("power_supply_ac_only"))
	if err != nil || b != nil {
		t.Errorf("ac only = %+v err %v", b, err)
	}

	b, err = readPowerSupply(dir("power_supply_missing"))
	if err != nil || b != nil {
		t.Errorf("missing dir = %+v err %v", b, err)
	}
}

func TestPmset(t *testing.T) {
	type want struct {
		pct               float64
		charging, plugged bool
		minutes           int // -1: none
	}
	cases := map[string]*want{
		"pmset_charging.txt":    {84, true, true, 83},
		"pmset_discharging.txt": {31, false, false, 601},
		"pmset_charged.txt":     {100, false, true, -1},
		"pmset_no_estimate.txt": {57, false, false, -1},
		"pmset_ac_attached.txt": {80, false, true, -1},
		"pmset_no_battery.txt":  nil,
	}
	for name, w := range cases {
		b := parsePmset(systemFixture(t, name))
		if w == nil {
			if b != nil {
				t.Errorf("%s = %+v, want nil", name, b)
			}
			continue
		}
		if b == nil {
			t.Errorf("%s = nil", name)
			continue
		}
		m := -1
		if b.MinutesLeft != nil {
			m = *b.MinutesLeft
		}
		if b.Percent != w.pct || b.Charging != w.charging || b.Plugged != w.plugged || m != w.minutes {
			t.Errorf("%s = %+v (minutes %d), want %+v", name, b, m, *w)
		}
	}
}

func TestSystemPsCPUSum(t *testing.T) {
	p, err := sumPsCPU([]byte("  0.3\n 150.0\n  49,7\n"), 4)
	if err != nil || p != 50 {
		t.Errorf("sum = %v, %v", p, err)
	}
	if p, _ := sumPsCPU([]byte("900\n"), 4); p != 100 {
		t.Errorf("capped = %v", p)
	}
	for _, bad := range []string{"", "x\n"} {
		if _, err := sumPsCPU([]byte(bad), 4); err == nil {
			t.Errorf("sumPsCPU(%q) parsed", bad)
		}
	}
}

func TestSystemDarwinSysctls(t *testing.T) {
	b := make([]byte, 24)
	for i, v := range []uint32{2048, 1024, 512} {
		binary.LittleEndian.PutUint32(b[i*4:], v)
	}
	binary.LittleEndian.PutUint64(b[16:], 2048)
	load, err := parseDarwinLoadavg(b)
	if err != nil || !reflect.DeepEqual(load, []float64{1, 0.5, 0.25}) {
		t.Errorf("load = %v, %v", load, err)
	}
	if _, err := parseDarwinLoadavg(b[:12]); err == nil {
		t.Error("short loadavg parsed")
	}

	x := make([]byte, 32)
	binary.LittleEndian.PutUint64(x, 4<<30)
	binary.LittleEndian.PutUint64(x[8:], 3<<30)
	binary.LittleEndian.PutUint64(x[16:], 1<<30)
	swap, err := parseXswUsage(x)
	if err != nil || swap == nil || swap.Total != 4<<30 || swap.Used != 1<<30 || swap.Percent != 25 {
		t.Errorf("swap = %+v, %v", swap, err)
	}
	swap, err = parseXswUsage(make([]byte, 32))
	if err != nil || swap != nil {
		t.Errorf("no swap = %+v, %v", swap, err)
	}

	mem := darwinMemory(16<<30, 63)
	if mem == nil || !mem.Approx || mem.Percent != 37 {
		t.Errorf("mem = %+v", mem)
	}
	if darwinMemory(16<<30, 101) != nil || darwinMemory(0, 50) != nil {
		t.Error("bad memory inputs gave stats")
	}
}

func TestSystemWindowsParsers(t *testing.T) {
	// 16 GB RAM, commit limit 20 GB: a 4 GB page file, 1 GB of it in use.
	const gb = 1 << 30
	swap := windowsSwap(16*gb, 6*gb, 20*gb, 9*gb)
	if swap == nil || swap.Total != 4*gb || swap.Used != gb || !swap.Approx {
		t.Errorf("swap = %+v", swap)
	}
	if windowsSwap(16*gb, 6*gb, 16*gb, 6*gb) != nil {
		t.Error("no page file gave swap")
	}

	b := windowsBattery(0, 0, 42, 5400)
	if b == nil || b.Percent != 42 || b.Plugged || b.Charging || b.MinutesLeft == nil || *b.MinutesLeft != 90 {
		t.Errorf("discharging = %+v", b)
	}
	b = windowsBattery(1, 8, 70, 0xFFFFFFFF)
	if b == nil || !b.Charging || !b.Plugged || b.MinutesLeft != nil {
		t.Errorf("charging = %+v", b)
	}
	for _, c := range [][2]byte{{128, 0}, {255, 50}, {0, 255}} {
		if b := windowsBattery(1, c[0], c[1], 0); b != nil {
			t.Errorf("flag %d percent %d = %+v, want nil", c[0], c[1], b)
		}
	}
}

func TestSystemDiskStats(t *testing.T) {
	// df: 100 total, 30 free for root, 25 for this user: 70 used of 95.
	d := newDiskStats("home", 100, 30, 25)
	if d.Label != "home" || d.Free != 25 || d.Percent != 73.7 {
		t.Errorf("disk = %+v", d)
	}
}

// Missing values are null in the JSON, never 0, and the label is a word.
func TestSystemStatsJSONNulls(t *testing.T) {
	b, err := json.Marshal(systemStats{Scope: scopeHost})
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{`"cpu":null`, `"load":null`, `"memory":null`, `"swap":null`, `"disks":null`, `"battery":null`} {
		if !strings.Contains(string(b), k) {
			t.Errorf("%s missing in %s", k, b)
		}
	}
}

// A live sample on this OS: whatever it reads, no field holds the home path.
func TestSystemCollectLive(t *testing.T) {
	s, _, _ := collectSystem(systemScope(), cpuTimes{})
	b, _ := json.Marshal(s)
	if home, err := os.UserHomeDir(); err == nil && strings.Contains(string(b), home) {
		t.Errorf("sample names the home dir: %s", b)
	}
	for _, d := range s.Disks {
		if d.Label != "home" && d.Label != "windows" {
			t.Errorf("disk label %q", d.Label)
		}
	}
}

// A rate read mid-change (a few µW) gives no estimate, not days.
func TestPowerSupplyAbsurdEstimate(t *testing.T) {
	dir := t.TempDir()
	bat := filepath.Join(dir, "BAT0")
	os.Mkdir(bat, 0o755)
	for f, v := range map[string]string{"type": "Battery", "status": "Discharging", "capacity": "50",
		"energy_now": "25000000", "energy_full": "50000000", "power_now": "3"} {
		os.WriteFile(filepath.Join(bat, f), []byte(v+"\n"), 0o644)
	}
	b, err := readPowerSupply(dir)
	if err != nil || b == nil || b.MinutesLeft != nil {
		t.Errorf("battery = %+v err %v", b, err)
	}
}

func TestSystemContainerMemory(t *testing.T) {
	const gb = 1 << 30
	kernel := uint64(16 * gb)
	stat := []byte("anon 100\ninactive_file 268435456\nactive_file 5\n")
	m := cgroupMemory([]byte("2147483648\n"), []byte("1342177280\n"), stat, "inactive_file", kernel)
	// 1.25 GB used, 0.25 GB of it reclaimable cache: 1 GB of a 2 GB limit.
	if m == nil || !m.Limit || m.Total != 2*gb || m.Used != gb || m.Percent != 50 {
		t.Errorf("v2 limit = %+v", m)
	}
	if m := cgroupMemory([]byte("max\n"), []byte("100\n"), nil, "inactive_file", kernel); m != nil {
		t.Errorf("no limit = %+v", m)
	}
	// v1 unlimited is about 2^63
	if m := cgroupMemory([]byte("9223372036854771712\n"), []byte("100\n"), nil, "total_inactive_file", kernel); m != nil {
		t.Errorf("v1 unlimited = %+v", m)
	}
	if m := cgroupMemory([]byte("2147483648"), nil, nil, "inactive_file", kernel); m != nil {
		t.Errorf("no usage = %+v", m)
	}

	// The files under a cgroup root, v2 then v1.
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "memory.max"), []byte("4294967296\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "memory.current"), []byte("1073741824\n"), 0o644)
	if m := containerMemory(dir, kernel); m == nil || m.Total != 4*gb || m.Used != gb {
		t.Errorf("v2 dir = %+v", m)
	}
	v1 := t.TempDir()
	os.Mkdir(filepath.Join(v1, "memory"), 0o755)
	os.WriteFile(filepath.Join(v1, "memory", "memory.limit_in_bytes"), []byte("1073741824\n"), 0o644)
	os.WriteFile(filepath.Join(v1, "memory", "memory.usage_in_bytes"), []byte("536870912\n"), 0o644)
	os.WriteFile(filepath.Join(v1, "memory", "memory.stat"), []byte("total_inactive_file 0\n"), 0o644)
	if m := containerMemory(v1, kernel); m == nil || m.Total != gb || m.Percent != 50 {
		t.Errorf("v1 dir = %+v", m)
	}
	if m := containerMemory(t.TempDir(), kernel); m != nil {
		t.Errorf("no cgroup files = %+v", m)
	}
}
