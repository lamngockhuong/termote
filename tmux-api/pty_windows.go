//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/charmbracelet/x/conpty"
	"golang.org/x/sys/windows"
)

// conptyStream runs a process on a Windows pseudo console.
//
// The child, not tmux-api, is put in a Job Object with KILL_ON_JOB_CLOSE: when
// tmux-api exits for any reason (including Stop-Process -Force) the job handle
// closes and the child tree dies. tmux-api itself must stay outside the job,
// otherwise a psmux server it starts would be killed with it.
//
// conpty.Spawn closes the thread handle, so the child cannot be created
// suspended and resumed after joining the job; it joins right after Spawn.
//
// conpty reads and writes raw handles. Reads and writes here go through
// duplicated handles wrapped in os.File instead, whose reference counting
// keeps a late Write from reaching a handle value Windows has already handed
// to another stream.
type conptyStream struct {
	pty       *conpty.ConPty
	in        *os.File
	out       *os.File
	mu        sync.Mutex // guards closed against Resize on a freed console
	closed    bool
	proc      windows.Handle
	job       windows.Handle
	done      chan struct{}
	code      int
	closeOnce sync.Once
}

// startTerminal starts argv on a new pseudo console of the given size.
func startTerminal(argv []string, size Size) (TermStream, error) {
	path, err := exec.LookPath(argv[0])
	if err != nil {
		return nil, err
	}
	job, err := newKillOnCloseJob()
	if err != nil {
		return nil, err
	}
	cpty, err := conpty.New(size.Cols, size.Rows, 0)
	if err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	args := append([]string{path}, argv[1:]...)
	_, handle, err := cpty.Spawn(path, args, &syscall.ProcAttr{Env: terminalEnv()})
	if err != nil {
		cpty.Close()
		windows.CloseHandle(job)
		return nil, err
	}
	proc := windows.Handle(handle)
	if err := windows.AssignProcessToJobObject(job, proc); err != nil {
		windows.TerminateProcess(proc, 1)
		windows.CloseHandle(proc)
		cpty.Close()
		windows.CloseHandle(job)
		return nil, fmt.Errorf("assign terminal to job object: %w", err)
	}
	in, err := dupFile(cpty.InPipeWriteFd(), "conpty-in")
	if err != nil {
		windows.TerminateJobObject(job, 1)
		windows.CloseHandle(proc)
		cpty.Close()
		windows.CloseHandle(job)
		return nil, err
	}
	out, err := dupFile(cpty.OutPipeReadFd(), "conpty-out")
	if err != nil {
		in.Close()
		windows.TerminateJobObject(job, 1)
		windows.CloseHandle(proc)
		cpty.Close()
		windows.CloseHandle(job)
		return nil, err
	}
	s := &conptyStream{pty: cpty, in: in, out: out, proc: proc, job: job, done: make(chan struct{})}
	go func() {
		windows.WaitForSingleObject(proc, windows.INFINITE)
		var code uint32
		if windows.GetExitCodeProcess(proc, &code) != nil {
			code = ^uint32(0)
		}
		s.code = int(int32(code))
		close(s.done)
	}()
	return s, nil
}

// dupFile duplicates a pipe handle owned by conpty into an os.File.
func dupFile(h uintptr, name string) (*os.File, error) {
	self := windows.CurrentProcess()
	var dup windows.Handle
	if err := windows.DuplicateHandle(self, windows.Handle(h), self, &dup, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
		return nil, fmt.Errorf("duplicate %s: %w", name, err)
	}
	return os.NewFile(uintptr(dup), name), nil
}

func newKillOnCloseJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return 0, err
	}
	return job, nil
}

func (s *conptyStream) Read(p []byte) (int, error)  { return s.out.Read(p) }
func (s *conptyStream) Write(p []byte) (int, error) { return s.in.Write(p) }
func (s *conptyStream) Done() <-chan struct{}       { return s.done }
func (s *conptyStream) ExitCode() int               { return s.code }

func (s *conptyStream) Resize(sz Size) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return os.ErrClosed
	}
	return s.pty.Resize(sz.Cols, sz.Rows)
}

// Close terminates the job, then closes the pseudo console. The order
// matters: ClosePseudoConsole blocks while any process is still attached to
// the console, and a console has no hang-up signal a client must obey.
func (s *conptyStream) Close() error {
	s.closeOnce.Do(func() {
		windows.TerminateJobObject(s.job, 1)
		select {
		case <-s.done:
		case <-time.After(processKillWait):
			windows.TerminateProcess(s.proc, 1)
			<-s.done
		}
		s.in.Close()
		s.mu.Lock()
		s.closed = true
		// Also closes conpty's own copies; the write end going away ends a
		// pending Read on s.out with EOF.
		s.pty.Close()
		s.mu.Unlock()
		s.out.Close()
		windows.CloseHandle(s.job)
		windows.CloseHandle(s.proc)
	})
	return nil
}

// terminalEnv is the server environment without TMUX, so `psmux attach` works
// when tmux-api itself runs inside psmux.
func terminalEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if strings.EqualFold(k, "TMUX") || strings.EqualFold(k, "TMUX_PANE") {
			continue
		}
		env = append(env, kv)
	}
	return env
}

// reapOrphanTerminals is a no-op on Windows: the Job Object already ends
// terminals whose server died.
func reapOrphanTerminals([]string) {}
