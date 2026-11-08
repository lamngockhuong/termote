package main

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// stallDialer is a machine that answers health, and every other request with
// a header promising a 100-byte body, then a part of it and nothing more, or
// with trickle, one byte every trickle until its end. closed gets one value
// each time a connection ends.
type stallDialer struct {
	fakeDialer
	closed  chan struct{}
	trickle time.Duration
}

func (d *stallDialer) dial(context.Context, machineRecord) (net.Conn, string, error) {
	mine, theirs := net.Pipe()
	go func() {
		defer theirs.Close()
		rd := bufio.NewReader(theirs)
		first, err := rd.ReadString('\n')
		if err != nil {
			return
		}
		for {
			line, err := rd.ReadString('\n')
			if err != nil {
				return
			}
			if line == "\r\n" {
				break
			}
		}
		if strings.Contains(first, "/api/mux/health ") {
			body := `{"status":"ok","apiVersion":` + itoa(apiVersion) + `}`
			theirs.Write([]byte("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: " + itoa(len(body)) + "\r\n\r\n" + body))
			return
		}
		defer func() { d.closed <- struct{}{} }()
		theirs.Write([]byte("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nConnection: close\r\nContent-Length: 100\r\n\r\n"))
		if d.trickle > 0 {
			for range 100 {
				time.Sleep(d.trickle)
				if _, err := theirs.Write([]byte("x")); err != nil {
					return
				}
			}
			return
		}
		theirs.Write([]byte("partial"))
		// Hold the body until this server closes the connection.
		io.Copy(io.Discard, rd)
	}()
	return mine, "", nil
}

// machineBodyServer is a main server whose one machine is d.
func machineBodyServer(t *testing.T, d *stallDialer) (*httptest.Server, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "machines.json")
	id := "0123456789abcdef"
	saveMachines(path, []machineRecord{testMachine(id, "Box", "box")})
	mm := newMachineManager(path, d)
	t.Cleanup(mm.stop)
	mux := http.NewServeMux()
	hub := newStreamHub(4)
	t.Cleanup(func() { hub.shutdown(context.Background()) })
	registerMachineProxy(mux, &agentAPI{machines: mm}, hub, hostAllowlist{}, "")
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, srv.URL + "/api/machines/" + id + "/mux/snapshot"
}

func setMachineBodyWaits(t *testing.T, idle, most time.Duration) {
	oldIdle, oldMost := machineResponseIdleWait, machineResponseBodyMost
	machineResponseIdleWait, machineResponseBodyMost = idle, most
	t.Cleanup(func() { machineResponseIdleWait, machineResponseBodyMost = oldIdle, oldMost })
}

// A machine that sends a header and then stalls its body loses the
// connection once the body stays idle for machineResponseIdleWait: the
// client's request ends and the slot is free again, though the client never
// gave up.
func TestMachineProxyBoundsBodyRead(t *testing.T) {
	setMachineBodyWaits(t, 100*time.Millisecond, time.Minute)
	d := &stallDialer{fakeDialer: fakeDialer{t: t}, closed: make(chan struct{}, machineMaxConns+2)}
	_, url := machineBodyServer(t, d)

	client := &http.Client{Timeout: 10 * time.Second}
	var wg sync.WaitGroup
	start := time.Now()
	// More requests than a machine has slots: each one's slot comes back.
	for range machineMaxConns + 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp, err := client.Get(url)
			if err != nil {
				t.Errorf("request: %v", err)
				return
			}
			defer resp.Body.Close()
			if _, err := io.ReadAll(resp.Body); err == nil {
				t.Error("a stalled body read to its end")
			}
		}()
	}
	wg.Wait()
	if d := time.Since(start); d > 5*time.Second {
		t.Errorf("stalled bodies took %v", d)
	}
	for i := range machineMaxConns + 2 {
		select {
		case <-d.closed:
		case <-time.After(5 * time.Second):
			t.Fatalf("connection %d to the machine still open", i+1)
		}
	}
}

// A body that keeps coming, however slowly, is read to its end past the idle
// wait; one longer than machineResponseBodyMost is cut there.
func TestMachineProxySlowBody(t *testing.T) {
	d := &stallDialer{fakeDialer: fakeDialer{t: t}, closed: make(chan struct{}, 4), trickle: 5 * time.Millisecond}
	_, url := machineBodyServer(t, d)
	client := &http.Client{Timeout: 10 * time.Second}
	get := func() (int, error) {
		resp, err := client.Get(url)
		if err != nil {
			return 0, err
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(resp.Body)
		return len(b), err
	}

	// 100 bytes over about 500 ms, never 50 ms apart.
	setMachineBodyWaits(t, 50*time.Millisecond, time.Minute)
	if n, err := get(); err != nil || n != 100 {
		t.Errorf("slow body = %d bytes, %v; want all 100", n, err)
	}
	setMachineBodyWaits(t, 50*time.Millisecond, 150*time.Millisecond)
	if n, err := get(); err == nil || n >= 100 {
		t.Errorf("body past the most = %d bytes, %v; want it cut", n, err)
	}
}
