package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
)

func TestOwnerOf(t *testing.T) {
	for _, tt := range []struct {
		uids []int
		want listenerOwner
	}{
		{nil, listenerNoneSeen},
		{[]int{1000}, listenerTrustedOwner},    // the current user
		{[]int{0}, listenerTrustedOwner},       // root (a container runtime's proxy)
		{[]int{1000, 0}, listenerTrustedOwner}, // dual stack
		{[]int{1000, 1001}, listenerOtherOwner},
		{[]int{1001}, listenerOtherOwner},
		{[]int{-1}, listenerOtherOwner}, // owner unreadable
	} {
		if got := ownerOf(tt.uids, 1000); got != tt.want {
			t.Errorf("ownerOf(%v) = %v, want %v", tt.uids, got, tt.want)
		}
	}
}

func TestProcNetListenerUIDs(t *testing.T) {
	table := `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1E00 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0000000000000000 100 0 0 10 0
   1: 00000000:1E00 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2 1 0000000000000000 100 0 0 10 0
   2: 0100007F:1E00 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1001        0 3 1 0000000000000000 20 4 30 10 -1
   3: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 4 1 0000000000000000 100 0 0 10 0
`
	// 0x1E00 = 7680; the established connection (01) and port 8080 do not count.
	got := procNetListenerUIDs(table, 7680)
	if len(got) != 2 || got[0] != 1000 || got[1] != 0 {
		t.Errorf("uids = %v, want [1000 0]", got)
	}
	if got := procNetListenerUIDs(table, 9999); len(got) != 0 {
		t.Errorf("free port = %v", got)
	}
	// An owner that does not parse is never trusted; a malformed address
	// is skipped.
	odd := "   0: 0100007F:1E00 00000000:0000 0A 0 0 0 x 0\n   1: 0100007F 00000000:0000 0A 0 0 0 0 0\n   2: 0100007F:ZZZZ 00000000:0000 0A 0 0 0 0 0\n"
	if got := procNetListenerUIDs(odd, 7680); len(got) != 1 || got[0] != -1 {
		t.Errorf("odd rows = %v, want [-1]", got)
	}
}

func TestLsofUIDs(t *testing.T) {
	got := lsofUIDs("p123\nu501\nf5\np456\nu0\nf7\n")
	if len(got) != 2 || got[0] != 501 || got[1] != 0 {
		t.Errorf("uids = %v", got)
	}
	if got := lsofUIDs(""); len(got) != 0 {
		t.Errorf("no output = %v", got)
	}
	if got := lsofUIDs("p1\nuroot\n"); len(got) != 1 || got[0] != -1 {
		t.Errorf("unparsable uid = %v, want [-1]", got)
	}
}

// A listener this process opened is the current user's.
func TestListenerOwnedLocallySelf(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if got := listenerOwnedLocally(ln.Addr().(*net.TCPAddr).Port); got != listenerTrustedOwner {
		t.Errorf("own listener = %v", got)
	}
}

// Something of another user listening on the port gets no password: the
// request never reaches it, and the code says why.
func TestFetchHealthWithholdsPasswordFromUntrustedListener(t *testing.T) {
	var gotAuth bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _, gotAuth = r.BasicAuth()
		w.Write([]byte(`{"status":"ok"}`))
	}))
	defer srv.Close()
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	old := listenerOwnerOf
	listenerOwnerOf = func(int) listenerOwner { return listenerOtherOwner }
	t.Cleanup(func() { listenerOwnerOf = old })

	if _, code := fetchHealth(port, "admin", "secret"); code != healthUntrusted || gotAuth {
		t.Errorf("code = %d, password sent = %v", code, gotAuth)
	}
	// Nothing seen listening, yet the port answers (a runtime forwarding it
	// without a proxy process): no password either, and a different reason.
	listenerOwnerOf = func(int) listenerOwner { return listenerNoneSeen }
	if _, code := fetchHealth(port, "admin", "secret"); code != healthUnverified || gotAuth {
		t.Errorf("unseen listener: code = %d, password sent = %v", code, gotAuth)
	}
	// Without a password there is nothing to withhold.
	if h, code := fetchHealth(port, "admin", ""); code != http.StatusOK || h.Status != "ok" {
		t.Errorf("no password: %d %+v", code, h)
	}
	// Nothing answering is still "not running".
	srv.Close()
	if _, code := fetchHealth(port, "admin", "secret"); code != 0 {
		t.Errorf("closed port = %d", code)
	}
}

// The listener checked is gone right after the check, and another takes its
// port: the password goes over the connection made before the check, to the
// listener that was checked, never to the one that came after.
func TestFetchHealthChecksTheConnectionUsed(t *testing.T) {
	var lateAuth atomic.Bool
	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"status":"ok"}`))
	}))
	port := first.Listener.Addr().(*net.TCPAddr).Port
	late := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _, ok := r.BasicAuth()
		lateAuth.Store(ok)
		w.Write([]byte(`{"status":"ok"}`))
	}))
	defer late.Close()
	old := listenerOwnerOf
	t.Cleanup(func() { listenerOwnerOf = old })
	listenerOwnerOf = func(int) listenerOwner {
		// Checked while the first listener still holds the port, which it
		// then loses.
		first.Close()
		ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err != nil {
			t.Errorf("rebind: %v", err)
			return listenerTrustedOwner
		}
		late.Listener = ln
		late.Start()
		return listenerTrustedOwner
	}
	fetchHealth(port, "admin", "secret")
	if lateAuth.Load() {
		t.Error("password sent to the listener that came after the check")
	}
}

func TestProcNetPeerUIDs(t *testing.T) {
	table := `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1E00 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1E00 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1001        0 0 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:D431 0100007F:1E00 01 00000000:00000000 00:00000000 00000000  1000        0 3 1 0000000000000000 20 4 30 10 -1
   3: 0A000001:1E00 0A000002:D431 01 00000000:00000000 00:00000000 00000000  1002        0 4 1 0000000000000000 20 4 30 10 -1
   4: 0000000000000000FFFF00000100007F:1E00 0000000000000000FFFF00000100007F:D432 01 0 0 0 x 0
`
	// 0x1E00 = 7680, 0xD431 = 54321: only the server end (row 1) of that
	// connection counts, not the listener, the client end or another host.
	if got := procNetPeerUIDs(table, 7680, 54321); len(got) != 1 || got[0] != 1001 {
		t.Errorf("uids = %v, want [1001]", got)
	}
	// tcp6, IPv4-mapped: an owner that does not parse is never trusted.
	if got := procNetPeerUIDs(table, 7680, 54322); len(got) != 1 || got[0] != -1 {
		t.Errorf("mapped = %v, want [-1]", got)
	}
	if got := procNetPeerUIDs(table, 7680, 1); len(got) != 0 {
		t.Errorf("no connection = %v", got)
	}
}
