//go:build !windows

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// herdrBin is the herdr CLI; tests replace it.
var herdrBin = "herdr"

// herdrObserveArgv is the command that streams a pane. The pane ID goes right
// after the subcommand: herdr takes the first argument as the target, so a
// "--" separator would itself be read as one. herdrPaneIDRe ensures the ID
// does not start with '-'.
func herdrObserveArgv(pane string, size Size) []string {
	return []string{herdrBin, "terminal", "session", "observe", pane,
		"--cols", strconv.Itoa(size.Cols), "--rows", strconv.Itoa(size.Rows)}
}

// isHerdrObserveCmdline matches a command line started by herdrObserveArgv.
func isHerdrObserveCmdline(cmdline string) bool {
	return strings.HasPrefix(cmdline, herdrBin+" terminal session observe ")
}

// Attach streams paneID at the pane's own size: an observer smaller than the
// pane crops it instead of reflowing, and herdr's `control` mode (which could
// resize) would resize the desktop pane too. The requested size is ignored.
func (m *herdrMux) Attach(ctx context.Context, paneID string, _ Size) (TermStream, error) {
	// Watch before reading the size, so a resize in between is not lost.
	resize := make(chan Size, 1)
	m.watchSize(paneID, resize)
	size, err := m.requirePane(ctx, paneID)
	if err != nil {
		m.unwatchSize(paneID, resize)
		return nil, err
	}
	pr, pw := io.Pipe()
	s := &herdrStream{
		m:      m,
		pane:   paneID,
		pr:     pr,
		pw:     pw,
		resize: resize,
		sizes:  make(chan sizeChange),
		stop:   make(chan struct{}),
		done:   make(chan struct{}),
	}
	go s.run(size)
	return s, nil
}

// herdrStream is one `herdr terminal session observe` process, restarted at
// the new size whenever the pane is resized. Its frames are screen renders:
// the first one of each process clears and redraws the whole screen.
type herdrStream struct {
	m    *herdrMux
	pane string

	pr *io.PipeReader
	pw *io.PipeWriter

	resize chan Size       // from layout events
	sizes  chan sizeChange // to the client

	stop     chan struct{}
	stopOnce sync.Once
	done     chan struct{}
	code     int
}

func (s *herdrStream) Read(p []byte) (int, error) { return s.pr.Read(p) }

// Write queues input for the pane without waiting for herdr. A failed
// send_text is only logged by the writer; a full queue fails the write, which
// ends the stream.
func (s *herdrStream) Write(p []byte) (int, error) {
	if _, err := s.m.writer(s.pane).enqueue(p); err != nil {
		return 0, err
	}
	return len(p), nil
}

// Resize is ignored; the pane keeps its desktop size.
func (s *herdrStream) Resize(Size) error { return nil }

func (s *herdrStream) Sizes() <-chan sizeChange { return s.sizes }
func (s *herdrStream) Done() <-chan struct{}    { return s.done }
func (s *herdrStream) ExitCode() int            { return s.code }

// Close stops the observer and waits until its process group is gone. It
// also closes the pipe: the reader may have stopped, and an observer being
// replaced for a resize would otherwise wait forever to hand over its output.
// stop is closed first so that run, seeing decoding end, knows why.
func (s *herdrStream) Close() error {
	s.stopOnce.Do(func() {
		close(s.stop)
		s.pw.CloseWithError(io.EOF)
	})
	<-s.done
	return nil
}

// herdrFrame is one line of observe output.
type herdrFrame struct {
	Type   string `json:"type"`
	Bytes  []byte `json:"bytes"` // base64 in JSON
	Reason string `json:"reason"`
}

func (s *herdrStream) run(size Size) {
	defer close(s.done)
	defer s.pw.Close()
	defer s.m.unwatchSize(s.pane, s.resize)
	for {
		if !s.announce(size) {
			return
		}
		p, err := startObserver(s.pane, size, s.pw)
		if err != nil {
			log.Printf("herdr observe %s: %v", s.pane, err)
			s.code = -1
			return
		}
		next, ended := s.follow(p, size)
		if ended {
			return
		}
		p.kill()
		size = next
	}
}

// follow waits until observer p ends (ended) or the pane takes a size other
// than size (next). A layout event for another pane of the tab repeats the
// same size and is skipped.
func (s *herdrStream) follow(p *observer, size Size) (next Size, ended bool) {
	for {
		select {
		case <-p.decoded:
			// Close also ends decoding (it closes the pipe): stop the
			// observer now rather than wait for it to exit on its own.
			select {
			case <-s.stop:
				p.kill()
			default:
				s.code = p.wait()
			}
			return Size{}, true
		case <-s.stop:
			p.kill()
			return Size{}, true
		case next = <-s.resize:
			if next != size {
				return next, false
			}
		}
	}
}

// announce tells the client the size before any output at that size. It
// returns false if the stream was closed meanwhile.
func (s *herdrStream) announce(size Size) bool {
	sent := make(chan struct{})
	select {
	case s.sizes <- sizeChange{Size: size, sent: sent}:
	case <-s.stop:
		return false
	}
	select {
	case <-sent:
		return true
	case <-s.stop:
		return false
	}
}

// observer is one running observe process.
type observer struct {
	cmd     *exec.Cmd
	stderr  *bytes.Buffer
	decoded chan struct{} // stdout ended
	closed  bool          // herdr reported terminal.closed
	waited  chan struct{}
	code    int
}

// startObserver runs observe for pane and copies each frame's bytes to out.
func startObserver(pane string, size Size, out io.Writer) (*observer, error) {
	argv := herdrObserveArgv(pane, size)
	// The environment is inherited: the CLI finds the server from
	// HERDR_SOCKET_PATH, as tmux-api itself does.
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.SysProcAttr = observerSysProcAttr()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	p := &observer{cmd: cmd, stderr: &bytes.Buffer{}, decoded: make(chan struct{}), waited: make(chan struct{})}
	cmd.Stderr = p.stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	go func() {
		defer close(p.decoded)
		r := bufio.NewReaderSize(stdout, 64*1024)
		for {
			line, err := r.ReadBytes('\n')
			if err != nil {
				return
			}
			var f herdrFrame
			if json.Unmarshal(line, &f) != nil {
				continue // not a frame (a warning, a future format); skip it
			}
			switch f.Type {
			case "terminal.frame":
				if _, err := out.Write(f.Bytes); err != nil {
					return
				}
			case "terminal.closed":
				p.closed = true
				return
			}
		}
	}()
	go func() {
		// Wait closes stdout, so it must not run before decoding has ended or
		// the last line (terminal.closed) could be lost.
		<-p.decoded
		err := cmd.Wait()
		var ee *exec.ExitError
		switch {
		case err == nil:
		case errors.As(err, &ee):
			p.code = ee.ExitCode()
		default:
			p.code = -1
		}
		close(p.waited)
	}()
	return p, nil
}

// wait returns the stream's exit code once observe ended by itself: 0 when
// the pane closed, otherwise the process's exit code.
func (p *observer) wait() int {
	select {
	case <-p.waited:
	case <-time.After(processKillWait):
		p.kill()
	}
	<-p.waited
	p.killGroup()
	if p.closed {
		return 0
	}
	if msg := strings.TrimSpace(p.stderr.String()); msg != "" {
		log.Printf("herdr observe exited (%d): %s", p.code, msg)
	}
	if p.code == 0 {
		return -1
	}
	return p.code
}

// kill ends the observer: SIGTERM, then SIGKILL after processKillWait.
func (p *observer) kill() {
	pid := p.cmd.Process.Pid
	select {
	case <-p.waited:
	default:
		syscall.Kill(-pid, syscall.SIGTERM)
	}
	select {
	case <-p.waited:
	case <-time.After(processKillWait):
		syscall.Kill(-pid, syscall.SIGKILL)
		<-p.waited
	}
	p.killGroup()
}

// killGroup removes anything left in the observer's process group. The kernel
// does not reuse a pid while it still names a live group.
func (p *observer) killGroup() {
	syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL)
}
