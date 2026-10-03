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

// herdrControlArgv streams a pane and sets its PTY to size, taking over from
// any other controlling client. The desktop keeps drawing the pane in its own
// frame; the PTY returns to that frame's size once control ends.
func herdrControlArgv(pane string, size Size) []string {
	return []string{herdrBin, "terminal", "session", "control", pane, "--takeover",
		"--cols", strconv.Itoa(size.Cols), "--rows", strconv.Itoa(size.Rows)}
}

// isHerdrStreamCmdline matches a command line started by herdrObserveArgv or
// herdrControlArgv.
func isHerdrStreamCmdline(cmdline string) bool {
	return strings.HasPrefix(cmdline, herdrBin+" terminal session observe ") ||
		strings.HasPrefix(cmdline, herdrBin+" terminal session control ")
}

// herdrTakenOver is the reason herdr gives a controlling client that another
// one took over from.
const herdrTakenOver = "terminal attach taken over"

// Reasons sent with a size frame when the stream left control mode without
// the client asking.
const (
	driveTakenOver = "taken-over"
	driveFailed    = "failed"
)

// minDriveSwitch is the shortest time between two mode switches, so a client
// toggling fast cannot spawn a process for each toggle.
const minDriveSwitch = 500 * time.Millisecond

// Attach streams paneID. By default it observes the pane at its own (desktop)
// size: an observer smaller than the pane crops it instead of reflowing. Once
// the client asks to drive the size (Drive), the stream switches to herdr's
// control mode at the client's size, which also resizes the pane's PTY.
// Nothing runs until the caller first calls Sizes (runStream always does).
func (m *herdrMux) Attach(ctx context.Context, paneID string, client Size) (TermStream, error) {
	// Watch before reading the size, so a resize in between is not lost.
	resize := make(chan Size, 1)
	m.watchSize(paneID, resize)
	size, err := m.requirePane(ctx, paneID)
	if err != nil {
		m.unwatchSize(paneID, resize)
		return nil, err
	}
	if client.Cols <= 0 || client.Rows <= 0 {
		client = size
	}
	pr, pw := io.Pipe()
	s := &herdrStream{
		m:          m,
		pane:       paneID,
		pr:         pr,
		pw:         pw,
		resize:     resize,
		clientSize: make(chan Size, 1),
		wantDrive:  make(chan bool, 1),
		sizes:      make(chan sizeChange),
		ready:      make(chan struct{}),
		stop:       make(chan struct{}),
		done:       make(chan struct{}),
	}
	go s.run(size, client)
	return s, nil
}

// herdrStream is one herdr process at a time streaming the pane: `observe`,
// restarted at the new size whenever the pane is resized, or `control` while
// the client drives the size. Its frames are screen renders: the first one of
// each process clears and redraws the whole screen.
type herdrStream struct {
	m    *herdrMux
	pane string

	pr *io.PipeReader
	pw *io.PipeWriter

	resize     chan Size       // from layout events
	clientSize chan Size       // latest client size (Resize)
	wantDrive  chan bool       // latest Drive request
	sizes      chan sizeChange // to the client

	// ready is closed by the first Sizes call: the client side is set up, so
	// a Drive asked for at open has arrived before the first process starts.
	ready     chan struct{}
	readyOnce sync.Once

	stop     chan struct{}
	stopOnce sync.Once
	done     chan struct{}
	code     int
}

func (s *herdrStream) Read(p []byte) (int, error) { return s.pr.Read(p) }

// Write queues input for the pane without waiting for herdr. A failed
// send_text is only logged by the writer; a full queue fails the write, which
// ends the stream. Input takes this path in both modes.
func (s *herdrStream) Write(p []byte) (int, error) {
	if _, err := s.m.writer(s.pane).enqueue(p); err != nil {
		return 0, err
	}
	return len(p), nil
}

// Resize records the client's size. It only reaches the pane while the client
// drives the size; otherwise the pane keeps its desktop size. It never blocks.
func (s *herdrStream) Resize(size Size) error {
	putLatest(s.clientSize, size)
	return nil
}

// Drive asks to take over the pane size (on) or to give it back. Only the
// latest request counts; it never blocks.
func (s *herdrStream) Drive(on bool) { putLatest(s.wantDrive, on) }

// putLatest replaces the value ch holds with v. ch has room for one value and
// each has a single sender, so the send after the drain never blocks.
func putLatest[T any](ch chan T, v T) {
	select {
	case <-ch:
	default:
	}
	ch <- v
}

func (s *herdrStream) Sizes() <-chan sizeChange {
	s.readyOnce.Do(func() { close(s.ready) })
	return s.sizes
}
func (s *herdrStream) Done() <-chan struct{} { return s.done }
func (s *herdrStream) ExitCode() int         { return s.code }

// Close stops the process and waits until its process group (its job on
// Windows) is gone. It also closes the pipe: the reader may have stopped, and
// a process being replaced would otherwise wait forever to hand over its
// output.
// stop is closed first so that run, seeing decoding end, knows why.
func (s *herdrStream) Close() error {
	s.stopOnce.Do(func() {
		close(s.stop)
		s.pw.CloseWithError(io.EOF)
	})
	<-s.done
	return nil
}

// herdrFrame is one line of observe or control output.
type herdrFrame struct {
	Type   string `json:"type"`
	Bytes  []byte `json:"bytes"` // base64 in JSON
	Reason string `json:"reason"`
}

// herdrMode is what the stream runs: the pane size and whether it drives it.
type herdrMode struct {
	size    Size
	driving bool
}

// run keeps one process streaming the pane until the stream ends. pane is the
// pane's own size, client the client's; want is the latest Drive request.
func (s *herdrStream) run(pane, client Size) {
	defer close(s.done)
	defer s.pw.Close()
	defer s.m.unwatchSize(s.pane, s.resize)
	select {
	case <-s.ready:
	case <-s.stop:
		return
	}
	want := false
	select {
	case want = <-s.wantDrive:
	default:
	}
	var reason string
	for {
		mode := herdrMode{size: pane, driving: want}
		if want {
			// The latest client size, without waiting for one.
			select {
			case client = <-s.clientSize:
			default:
			}
			mode.size = client
		}
		if !s.announce(sizeChange{Size: mode.size, Driving: mode.driving, Reason: reason}) {
			return
		}
		reason = ""
		switched := time.Now()
		p, err := s.start(mode)
		if err != nil {
			log.Printf("herdr %s %s: %v", modeName(mode), s.pane, err)
			if !mode.driving {
				s.code = -1
				return
			}
			// herdr without control mode (or a failed start): observe instead.
			want, reason = false, driveFailed
			if pane, err = s.paneSize(pane); err != nil {
				return // the pane is gone: exit code 0, as when it closes
			}
			continue
		}
		next := s.follow(p, mode, switched, &pane, &client, &want)
		switch next {
		case followEnded:
			return
		case followSwitch:
			if mode.driving {
				p.release()
			} else {
				p.kill()
			}
		case followLost:
			// control ended by itself: taken over, or failed.
			want = false
			if p.reason == herdrTakenOver {
				reason = driveTakenOver
			} else {
				reason = driveFailed
				log.Printf("herdr control %s ended (%d): %s", s.pane, p.code, p.reason)
			}
		case followRestart:
			p.kill()
		}
		if next == followSwitch && mode.driving {
			// The desktop may have resized the pane meanwhile. (followLost
			// has just read the size.)
			var err error
			if pane, err = s.paneSize(pane); err != nil {
				return // the pane is gone: exit code 0, as when it closes
			}
		}
	}
}

func modeName(m herdrMode) string {
	if m.driving {
		return "control"
	}
	return "observe"
}

// paneSize asks herdr for the pane's size now. A pane that is gone ends the
// stream (err); any other failure keeps the last size known.
func (s *herdrStream) paneSize(last Size) (Size, error) {
	// Close must not wait for a slow herdr.
	ctx, cancel := context.WithTimeout(context.Background(), muxTimeout)
	defer cancel()
	go func() {
		select {
		case <-s.stop:
			cancel()
		case <-ctx.Done():
		}
	}()
	size, err := s.m.requirePane(ctx, s.pane)
	var ie inputError
	if errors.As(err, &ie) {
		return Size{}, err
	}
	if err != nil {
		log.Printf("herdr pane %s size: %v", s.pane, err)
		return last, nil
	}
	return size, nil
}

func (s *herdrStream) start(mode herdrMode) (*observer, error) {
	if mode.driving {
		return startHerdrStream(herdrControlArgv(s.pane, mode.size), true, s.pw)
	}
	return startHerdrStream(herdrObserveArgv(s.pane, mode.size), false, s.pw)
}

// What follow returns.
type followResult int

const (
	followEnded   followResult = iota // the stream is over
	followRestart                     // observe at the new pane size
	followSwitch                      // switch mode, as the client asked
	followLost                        // control ended by itself; observe again
)

// follow runs process p in mode until the stream ends or another process is
// needed. It keeps pane, client and want up to date, and switches mode no
// sooner than minDriveSwitch after switched. A layout event for another pane
// of the tab repeats the same size and is skipped.
func (s *herdrStream) follow(p *observer, mode herdrMode, switched time.Time, pane, client *Size, want *bool) followResult {
	var wait <-chan time.Time
	sent := mode.size // control's PTY size
	for {
		select {
		case <-p.decoded:
			// Close also ends decoding (it closes the pipe): stop the
			// process now rather than wait for it to exit on its own.
			select {
			case <-s.stop:
				p.stopFor(mode)
				return followEnded
			default:
			}
			code := p.wait()
			// Control ending by itself does not end the stream while the pane
			// is still there: observe it again. Only the pane going away does,
			// whatever reason herdr gave.
			if mode.driving {
				if p.reason == herdrTakenOver {
					if size, err := s.paneSize(*pane); err == nil {
						*pane = size
					}
					return followLost
				}
				if size, err := s.paneSize(*pane); err == nil {
					*pane = size
					return followLost
				}
			}
			s.code = code
			return followEnded
		case <-s.stop:
			p.stopFor(mode)
			return followEnded
		case next := <-s.resize:
			*pane = next
			if !mode.driving && next != mode.size {
				return followRestart
			}
		case next := <-s.clientSize:
			*client = next
			if mode.driving && next != sent {
				sent = next
				p.resizeTo(next)
			}
		case *want = <-s.wantDrive:
			if *want == mode.driving {
				wait = nil
				continue
			}
			if d := minDriveSwitch - time.Since(switched); d > 0 {
				wait = time.After(d)
				continue
			}
			return followSwitch
		case <-wait:
			if *want != mode.driving {
				return followSwitch
			}
			wait = nil
		}
	}
}

// announce tells the client the size before any output at that size. It
// returns false if the stream was closed meanwhile.
func (s *herdrStream) announce(c sizeChange) bool {
	sent := make(chan struct{})
	c.sent = sent
	select {
	case s.sizes <- c:
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

// observerStderrMax caps what is kept of an observer's stderr: only its
// start is ever logged.
const observerStderrMax = 64 << 10

// cappedBuffer keeps the first max bytes written to it and drops the rest,
// still reporting each write as complete so the process never blocks on it.
// The buffer is a field, not embedded: an embedded bytes.Buffer would bring
// its ReadFrom, which io.Copy (os/exec's stderr copy) prefers to Write.
type cappedBuffer struct {
	buf bytes.Buffer
	max int
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if room := b.max - b.buf.Len(); room > 0 {
		b.buf.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}

func (b *cappedBuffer) String() string { return b.buf.String() }

// observer is one running observe or control process. How it is stopped
// depends on the OS: a process group on Unix, a Job Object on Windows
// (observerProc).
type observer struct {
	observerProc
	cmd     *exec.Cmd
	stderr  *cappedBuffer
	decoded chan struct{} // stdout ended
	closed  bool          // herdr reported terminal.closed
	reason  string        // its reason
	waited  chan struct{}
	code    int

	// control only: the latest size for its stdin writer, closed to close
	// stdin. Only run sends on it.
	resizes   chan Size
	stdinOnce sync.Once
}

// startHerdrStream runs argv (observe, or control when stdin is set) and
// copies each frame's bytes to out.
func startHerdrStream(argv []string, stdin bool, out io.Writer) (*observer, error) {
	// The environment is inherited: the CLI finds the server from
	// HERDR_SOCKET_PATH, as the server itself does.
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.SysProcAttr = observerSysProcAttr()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var in io.WriteCloser
	if stdin {
		if in, err = cmd.StdinPipe(); err != nil {
			return nil, err
		}
	}
	p := &observer{cmd: cmd, stderr: &cappedBuffer{max: observerStderrMax}, decoded: make(chan struct{}), waited: make(chan struct{})}
	cmd.Stderr = p.stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	if err := p.attach(); err != nil {
		cmd.Process.Kill()
		cmd.Wait()
		return nil, err
	}
	if in != nil {
		p.resizes = make(chan Size, 1)
		go p.writeResizes(in)
	}
	go func() {
		defer close(p.decoded)
		r := bufio.NewReaderSize(stdout, 64*1024)
		for {
			line, err := readHerdrLine(r, herdrMaxReply)
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
				p.reason = f.Reason
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

// writeResizes sends each size to control's stdin, in its own goroutine so a
// process that stops reading blocks nothing else; killing the process fails
// the stuck write. Stdin is closed once resizes is.
func (p *observer) writeResizes(in io.WriteCloser) {
	defer in.Close()
	enc := json.NewEncoder(in)
	for size := range p.resizes {
		msg := map[string]any{"type": "terminal.resize", "cols": size.Cols, "rows": size.Rows}
		if enc.Encode(msg) != nil {
			return
		}
	}
}

// resizeTo resizes control's PTY in place.
func (p *observer) resizeTo(size Size) { putLatest(p.resizes, size) }

// closeInput closes control's stdin (through its writer); observe has none.
func (p *observer) closeInput() {
	if p.resizes != nil {
		p.stdinOnce.Do(func() { close(p.resizes) })
	}
}

// release ends control: closing stdin makes herdr give the PTY back its
// desktop size and exit. A process still there after processKillWait is
// killed.
func (p *observer) release() {
	p.closeInput()
	select {
	case <-p.waited:
		p.killGroup()
	case <-time.After(processKillWait):
		p.kill()
	}
}

// stopFor stops p the way its mode needs: control gives the size back first.
func (p *observer) stopFor(mode herdrMode) {
	if mode.driving {
		p.release()
		return
	}
	p.kill()
}

// wait returns the stream's exit code once the process ended by itself: 0
// when herdr reported the terminal closed, otherwise the process's exit code.
func (p *observer) wait() int {
	// Its stdin writer would wait for sizes forever.
	p.closeInput()
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
		log.Printf("herdr stream exited (%d): %s", p.code, msg)
	}
	if p.code == 0 {
		return -1
	}
	return p.code
}
