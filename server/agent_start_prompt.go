package main

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"time"
)

// A prompt given to an agent at its start (agent/start {kind, prompt}) is
// never typed: it is written to a file of the server's own, and the line
// typed into the pane's shell reads that file back as one argument when it
// runs (promptSubstitution). The line holds only the program, the server's
// arguments and the file's path, so nothing in the prompt can become shell
// code, a key the line editor acts on (Tab, a line break) or an option of
// the agent's.

// startPromptKeep is how long a prompt's file is kept: the shell reads it
// as soon as the line runs, well within the start's own deadline. Tests
// shorten it.
var startPromptKeep = agentStartTimeout + agentStartGrace

var errStartPromptShell = &codedError{code: "prompt_unsupported_shell", msg: "this shell cannot take a prompt at start (bash, zsh, sh, fish; not on Windows)", status: http.StatusConflict}

// startPromptGOOS is the OS a prompt is refused on (startShellOK); tests
// change it.
var startPromptGOOS = runtime.GOOS

// startPromptDir is where prompts' files go: the user's cache dir, as
// uploads. Empty when there is none. Tests replace it.
var startPromptDir = func() string {
	cache, err := os.UserCacheDir()
	if err != nil {
		return ""
	}
	return filepath.Join(cache, "termote", "start-prompts")
}

// startPromptNameRe: the names writeStartPrompt makes (os.CreateTemp puts
// digits in place of the *).
var startPromptNameRe = regexp.MustCompile(`^prompt-[0-9]+\.txt$`)

// writeStartPrompt writes text to a new file (0600) in startPromptDir (0700,
// not a symlink, on Unix the server user's own), after deleting the ones
// older than startPromptKeep that a stopped server left, and returns its
// path.
func writeStartPrompt(text string) (string, error) {
	dir := startPromptDir()
	if dir == "" {
		return "", errors.New("no cache dir for the prompt")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if fi, err := os.Lstat(dir); err != nil || !fi.IsDir() {
		return "", fmt.Errorf("%s is not a directory", dir)
	}
	if err := checkPrivateDir(dir); err != nil {
		return "", err
	}
	sweepStartPrompts(dir, time.Now())
	f, err := os.CreateTemp(dir, "prompt-*.txt")
	if err != nil {
		return "", err
	}
	_, err = f.WriteString(text)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	// The path goes on the line, quoted: one the shell could not be handed
	// as typed (a control character) is not used.
	if err == nil && !validTaskDir(f.Name()) {
		err = errors.New("the prompt's path cannot be typed")
	}
	if err != nil {
		removeStartPrompt(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// removeStartPrompt deletes a prompt's file.
func removeStartPrompt(path string) {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("agent start prompt: remove: %v", err)
	}
}

// sweepStartPrompts deletes the prompts' files in dir older than
// startPromptKeep; only regular files named as writeStartPrompt names them.
func sweepStartPrompts(dir string, now time.Time) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !startPromptNameRe.MatchString(e.Name()) {
			continue
		}
		fi, err := e.Info()
		if err == nil && fi.Mode().IsRegular() && now.Sub(fi.ModTime()) > startPromptKeep {
			removeStartPrompt(filepath.Join(dir, e.Name()))
		}
	}
}

// promptSubstitution is, in shell's syntax, one word that the shell
// replaces by the contents of the file at path when the line runs (less
// its trailing line breaks), with nothing in them expanded, split or run:
// POSIX "$(...)", fish's (... | string collect). `command` skips an alias
// or function named cat. pwsh has none: a prompt is refused there.
func promptSubstitution(shell, path string) string {
	q := shellQuote(shell, path)
	if shell == shellFish {
		return "(command cat -- " + q + " | string collect)"
	}
	return `"$(command cat -- ` + q + `)"`
}

// agentPromptWords are the words after kind's arguments that hand it the
// prompt read from path: Claude Code and Codex take it as their positional
// argument, after -- so a prompt starting with - (or naming one of their
// subcommands) is still the prompt; OpenCode as --prompt=, one word.
func agentPromptWords(shell, kind, path string) []string {
	sub := promptSubstitution(shell, path)
	if kind == "opencode" {
		return []string{"--prompt=" + sub}
	}
	return []string{"--", sub}
}
