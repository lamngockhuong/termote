package main

import (
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"
)

// The Windows supervisors live in a file without a _windows suffix: they only run
// commands through c.run and write files, so their tests run on every OS.

const windowsTaskName = "Termote"

// taskSupervisor runs serve as a Scheduled Task started at logon. The task
// restarts it after a failure (3 times, a minute apart).
type taskSupervisor struct{ c *cli }

func (t *taskSupervisor) Name() string    { return "scheduled task" }
func (t *taskSupervisor) AutoStart() bool { return true }

func (t *taskSupervisor) Available() bool {
	_, err := t.c.run.LookPath("schtasks")
	return err == nil
}

func (t *taskSupervisor) Installed() bool {
	_, err := t.schtasks("/Query", "/TN", windowsTaskName)
	return err == nil
}

func (t *taskSupervisor) schtasks(args ...string) ([]byte, error) {
	return t.c.run.Output("", nil, "schtasks", args...)
}

// windowsTaskXML is the task definition. The logon trigger and interactive
// token need no administrator rights; `serve --service` hides the console
// window the task opens.
func windowsTaskXML(user, exe string) string {
	esc := func(s string) string {
		var b strings.Builder
		xml.EscapeText(&b, []byte(s))
		return b.String()
	}
	return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Termote server (written by termote start)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>` + esc(user) + `</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>` + esc(user) + `</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>StopExisting</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>` + esc(exe) + `</Command>
      <Arguments>serve --service</Arguments>
    </Exec>
  </Actions>
</Task>
`
}

// utf16File encodes s as UTF-16LE with a BOM, which schtasks /XML expects.
func utf16File(s string) []byte {
	u := utf16.Encode([]rune(s))
	b := make([]byte, 2+2*len(u))
	b[0], b[1] = 0xFF, 0xFE
	for i, r := range u {
		b[2+2*i], b[3+2*i] = byte(r), byte(r>>8)
	}
	return b
}

// Install creates or replaces the task. The environment is inherited from the
// user's logon session, which already has the PATH psmux was installed to.
func (t *taskSupervisor) Install(exe string, _ map[string]string) error {
	user := t.c.commandLine("whoami")
	if user == "" {
		return errors.New("cannot tell the current user (whoami)")
	}
	if err := ensureDir(t.c.stateDir()); err != nil {
		return err
	}
	path := filepath.Join(t.c.stateDir(), "termote-task.xml")
	if err := os.WriteFile(path, utf16File(windowsTaskXML(user, exe)), 0o600); err != nil {
		return err
	}
	defer os.Remove(path)
	if out, err := t.schtasks("/Create", "/TN", windowsTaskName, "/XML", path, "/F"); err != nil {
		return fmt.Errorf("schtasks /Create: %v %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (t *taskSupervisor) Start() error {
	t.Stop()
	if _, err := t.schtasks("/Run", "/TN", windowsTaskName); err != nil {
		return fmt.Errorf("schtasks /Run: %w", err)
	}
	return nil
}

// Stop ends the task and, since /End may leave the server itself running,
// the server recorded in the PID file.
func (t *taskSupervisor) Stop() error {
	t.schtasks("/End", "/TN", windowsTaskName)
	return (&detachedSupervisor{c: t.c}).Stop()
}

func (t *taskSupervisor) Status() (bool, int, error) {
	p, ok := t.c.serverProcess()
	return ok, p.PID, nil
}

func (t *taskSupervisor) Uninstall() error {
	t.Stop()
	if t.Installed() {
		if _, err := t.schtasks("/Delete", "/TN", windowsTaskName, "/F"); err != nil {
			return fmt.Errorf("schtasks /Delete: %w", err)
		}
	}
	return nil
}

// startupSupervisor is the fallback when a Scheduled Task cannot be created
// (company policy): a hidden launcher in the user's Startup folder starts
// serve at logon. Nothing restarts it after a crash.
type startupSupervisor struct{ c *cli }

func (s *startupSupervisor) Name() string    { return "startup folder" }
func (s *startupSupervisor) AutoStart() bool { return true }

// Available is false: it is only chosen when the task fails (see start).
func (s *startupSupervisor) Available() bool { return false }

func (s *startupSupervisor) launcherPath() string {
	appData := s.c.envDir("APPDATA", filepath.Join(s.c.home, "AppData", "Roaming"))
	return filepath.Join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Termote.vbs")
}

func (s *startupSupervisor) Installed() bool { return fileExists(s.launcherPath()) }

// startupLauncher runs `<exe> serve --service` without a window.
func startupLauncher(exe string) string {
	quoted := `""` + strings.ReplaceAll(exe, `"`, `""`) + `""`
	return "' Written by termote start; termote uninstall removes it.\r\n" +
		`CreateObject("WScript.Shell").Run "` + quoted + ` serve --service", 0, False` + "\r\n"
}

func (s *startupSupervisor) Install(exe string, _ map[string]string) error {
	if err := ensureDir(filepath.Dir(s.launcherPath())); err != nil {
		return err
	}
	return os.WriteFile(s.launcherPath(), []byte(startupLauncher(exe)), 0o644)
}

func (s *startupSupervisor) Start() error {
	s.Stop()
	if err := s.c.run.Run("", nil, "wscript.exe", s.launcherPath()); err != nil {
		return fmt.Errorf("start %s: %w", s.launcherPath(), err)
	}
	return nil
}

func (s *startupSupervisor) Stop() error { return (&detachedSupervisor{c: s.c}).Stop() }

func (s *startupSupervisor) Status() (bool, int, error) {
	p, ok := s.c.serverProcess()
	return ok, p.PID, nil
}

func (s *startupSupervisor) Uninstall() error {
	s.Stop()
	return removeFile(s.launcherPath())
}
