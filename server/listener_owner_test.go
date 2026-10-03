package main

import (
	"net"
	"net/http"
	"net/http/httptest"
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
