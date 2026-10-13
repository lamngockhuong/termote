package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const (
	// zellijMaxFrame caps one subscribe line (a whole screen render).
	zellijMaxFrame = 1 << 20
	// zellijMaxRow caps one row of a render.
	zellijMaxRow = 64 << 10
	// zellijViewSizeCheck is how often, at most, a view stream reads the
	// pane's size again while frames arrive: a render carries no size.
	zellijViewSizeCheck = 2 * time.Second
	// zellijViewStderrMax caps what is kept of subscribe's stderr.
	zellijViewStderrMax = 4 << 10
	// zellijSubscribeConnect is how long subscribe is given to connect
	// before other commands run again.
	zellijSubscribeConnect = 200 * time.Millisecond
)

// zellijFrame is one line of `zellij subscribe -f json`.
type zellijFrame struct {
	Event    string   `json:"event"`
	PaneID   string   `json:"pane_id"`
	Viewport []string `json:"viewport"`
}

// zellijViewStream is a view-only stream: `zellij subscribe` on one pane,
// each render repainted over the last. It needs no client, changes nothing
// and takes no input; its size is the pane's, sent as a size frame before
// any render at that size.
type zellijViewStream struct {
	pr    *io.PipeReader
	pw    *io.PipeWriter
	sizes chan sizeChange
	proc  *observer

	stop     chan struct{}
	stopOnce sync.Once
	done     chan struct{}
	code     int
}

// CanView: subscribe changes nothing, on every supported Zellij.
func (m *zellijMux) CanView(ctx context.Context) bool {
	_, err := zellijCheckVersion(ctx)
	return err == nil
}

// AttachView subscribes to paneID's renders at the pane's own size.
func (m *zellijMux) AttachView(ctx context.Context, paneID string, _ Size) (TermStream, error) {
	session, n, err := m.requirePane(ctx, paneID)
	if err != nil {
		return nil, err
	}
	size, err := zellijPaneSize(ctx, session, n)
	if err != nil {
		return nil, err
	}
	argv := zellijSubscribeArgv(session, n)
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = zellijEnv()
	cmd.SysProcAttr = observerSysProcAttr()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	p := &observer{cmd: cmd, stderr: &cappedBuffer{max: zellijViewStderrMax}, decoded: make(chan struct{}), waited: make(chan struct{})}
	cmd.Stderr = p.stderr
	// subscribe connects as a client too (see zellijGate).
	zellijGate.RLock()
	err = cmd.Start()
	if err == nil {
		time.Sleep(zellijSubscribeConnect)
	}
	zellijGate.RUnlock()
	if err != nil {
		return nil, err
	}
	if err := p.attach(); err != nil {
		cmd.Process.Kill()
		cmd.Wait()
		return nil, err
	}
	pr, pw := io.Pipe()
	s := &zellijViewStream{pr: pr, pw: pw, sizes: make(chan sizeChange), proc: p,
		stop: make(chan struct{}), done: make(chan struct{})}
	go s.decode(stdout, size, func(ctx context.Context) (Size, error) { return zellijPaneSize(ctx, session, n) })
	go func() {
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
		p.killGroup()
		if !p.closed {
			if msg := strings.TrimSpace(p.stderr.String()); msg != "" {
				log.Printf("zellij subscribe exited (%d): %s", p.code, msg)
			}
			// Ended without pane_closed: not the pane's end.
			s.code = p.code
			if s.code == 0 {
				s.code = -1
			}
		}
		s.pw.CloseWithError(io.EOF)
		close(s.done)
	}()
	return s, nil
}

// decode turns subscribe's lines into repaints. readSize reads the pane's
// size again; a changed size is sent (and its frame waited for) before the
// next render.
func (s *zellijViewStream) decode(stdout io.Reader, size Size, readSize func(context.Context) (Size, error)) {
	defer close(s.proc.decoded)
	// Decoding that stops early (a frame too large, a closed stream) ends
	// subscribe too: nobody would read its output, and it would block.
	defer func() {
		if !s.proc.closed && s.proc.cmd != nil {
			go s.proc.kill()
		}
	}()
	if !s.sendSize(size) {
		return
	}
	checked := time.Now()
	r := bufio.NewReaderSize(stdout, 64*1024)
	for {
		line, err := readHerdrLine(r, zellijMaxFrame)
		if err != nil {
			return
		}
		var f zellijFrame
		if json.Unmarshal(line, &f) != nil {
			continue
		}
		switch f.Event {
		case "pane_closed":
			s.proc.closed = true
			return
		case "pane_update":
		default:
			continue
		}
		if time.Since(checked) >= zellijViewSizeCheck || len(f.Viewport) > size.Rows {
			ctx, cancel := context.WithTimeout(context.Background(), muxTimeout)
			got, err := readSize(ctx)
			cancel()
			checked = time.Now()
			if err == nil && got != size {
				size = got
				if !s.sendSize(size) {
					return
				}
			}
		}
		frame, ok := zellijRepaint(f.Viewport, size)
		if !ok {
			log.Printf("zellij subscribe: render row too long, view stream ended")
			return
		}
		if _, err := s.pw.Write(frame); err != nil {
			return
		}
	}
}

// sendSize sends a size frame and waits until it went out.
func (s *zellijViewStream) sendSize(size Size) bool {
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

// zellijRepaint draws a render over the screen: home, each row with the
// rest of its line erased, the rows below erased, cursor hidden. false: a
// row is longer than zellijMaxRow.
func zellijRepaint(rows []string, size Size) ([]byte, bool) {
	var b strings.Builder
	b.WriteString("\x1b[?25l\x1b[H")
	for i, row := range rows {
		if i >= size.Rows {
			break
		}
		if len(row) > zellijMaxRow {
			return nil, false
		}
		if i > 0 {
			b.WriteString("\r\n")
		}
		b.WriteString(row)
		b.WriteString("\x1b[m\x1b[K")
	}
	b.WriteString("\x1b[m\x1b[J")
	return []byte(b.String()), true
}

func (s *zellijViewStream) Read(p []byte) (int, error) { return s.pr.Read(p) }

// Write drops input: a view-only stream never types (the stream route drops
// it before it gets here, too).
func (s *zellijViewStream) Write(p []byte) (int, error) { return len(p), nil }
func (s *zellijViewStream) Resize(Size) error           { return nil }
func (s *zellijViewStream) Sizes() <-chan sizeChange    { return s.sizes }
func (s *zellijViewStream) Done() <-chan struct{}       { return s.done }
func (s *zellijViewStream) ExitCode() int               { return s.code }

// Close stops subscribe and waits until its process group is gone.
func (s *zellijViewStream) Close() error {
	s.stopOnce.Do(func() {
		close(s.stop)
		s.pw.CloseWithError(io.EOF)
		s.proc.kill()
	})
	<-s.done
	return nil
}
