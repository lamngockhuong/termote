package main

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStatusHostSummary(t *testing.T) {
	const gb = 1 << 30
	left := 125
	full := &systemStats{
		Scope:   scopeHost,
		CPU:     &cpuStats{Percent: 23.4, Count: 8},
		Load:    []float64{1.23, 1, 0.5},
		Memory:  &memStats{Total: 16 * gb, Used: 98 * gb / 10, Percent: 61.2},
		Swap:    &memStats{Total: 2 * gb, Used: gb / 2, Percent: 25},
		Disks:   []diskStats{{Label: "home", Total: 500 * gb, Free: 120 * gb, Percent: 76}},
		Battery: &batteryStats{Percent: 84, Charging: true, Plugged: true},
	}
	want := "CPU 23% · load 1.2 · RAM 61% (9.8/16 GB) · swap 25% · disk 120 GB free · battery 84% charging"
	if got := hostSummary(full); got != want {
		t.Errorf("full:\n got %q\nwant %q", got, want)
	}

	if got := hostSummary(&systemStats{Scope: scopeHost}); got != "" {
		t.Errorf("all null = %q", got)
	}
	if hostSummary(nil) != "" {
		t.Error("nil gave a line")
	}

	wsl := &systemStats{
		Scope:   scopeWSL,
		Memory:  &memStats{Total: 8 * gb, Used: 4 * gb, Percent: 50},
		Disks:   []diskStats{{Label: "home", Free: 900 * gb}, {Label: "windows", Free: gb / 2}},
		Battery: &batteryStats{Percent: 40, MinutesLeft: &left},
	}
	want = "RAM 50% (4/8 GB) · disk 900 GB free · C: 512 MB free · battery 40% (2:05 left) (WSL VM)"
	if got := hostSummary(wsl); got != want {
		t.Errorf("wsl:\n got %q\nwant %q", got, want)
	}

	limited := &systemStats{Scope: scopeContainer, Memory: &memStats{Total: 2 * gb, Used: gb, Percent: 50, Limit: true}}
	want = "RAM 50% (1/2 GB limit) (container)"
	if got := hostSummary(limited); got != want {
		t.Errorf("limit:\n got %q\nwant %q", got, want)
	}

	mac := &systemStats{Scope: scopeContainer, Memory: &memStats{Total: 16 * gb, Used: 6 * gb, Percent: 37.5, Approx: true},
		Battery: &batteryStats{Percent: 100, Plugged: true}}
	want = "RAM ~38% (6/16 GB) · battery 100% plugged in (container)"
	if got := hostSummary(mac); got != want {
		t.Errorf("approx:\n got %q\nwant %q", got, want)
	}
}

// status --json carries the server's host stats; a server without the
// route (an older one answers its JSON 404) leaves them out.
func TestStatusHostReport(t *testing.T) {
	tc := newTestCLI(t, "linux")
	withSystem := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/mux/system" {
			if !withSystem {
				http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
				return
			}
			fmt.Fprint(w, `{"scope":"wsl","cpu":{"percent":12,"count":4},"load":[0.5,0.4,0.3],"memory":null,"swap":null,"disks":[],"battery":null,"history":[{"t":"2026-11-01T00:00:00Z","cpu":1,"mem":2}]}`)
			return
		}
		fmt.Fprint(w, herdrHealth)
	}))
	t.Cleanup(srv.Close)
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	r := tc.statusReport(&savedConfig{Password: "pw"}, port)
	if r.System == nil || r.System.Scope != scopeWSL || r.System.CPU.Percent != 12 {
		t.Fatalf("system = %+v", r.System)
	}
	withSystem = false
	if r := tc.statusReport(&savedConfig{Password: "pw"}, port); !r.Running || r.System != nil {
		t.Fatalf("without the route: %+v", r)
	}
}
