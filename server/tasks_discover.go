package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

const (
	// maxTaskFile bounds package.json and the Makefile as read.
	maxTaskFile = 1 << 20
	// maxTaskItems caps the scripts, and the targets, listed.
	maxTaskItems = 500
	// maxScriptShown cuts a script's command as listed (its whole text
	// runs: the server builds `<pm> run <name>`).
	maxScriptShown = 4096
)

var (
	// taskNameRe is every script or target name the Tasks view lists and
	// runs: no shell or tmux format character, no leading dash (an option).
	taskNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9:_.@/+-]{0,99}$`)

	errTaskFileNotRegular = errors.New("not a regular file")
	errTaskFileTooLarge   = errors.New("file too large")
)

func validTaskName(name string) bool { return taskNameRe.MatchString(name) }

// scriptTask is one script of package.json. Hooks names the pre<name> and
// post<name> scripts that npm, pnpm and bun run around it.
type scriptTask struct {
	Name      string   `json:"name"`
	Command   string   `json:"command"`
	Hooks     []string `json:"hooks,omitempty"`
	Truncated bool     `json:"truncated,omitempty"`
}

type makeTarget struct {
	Name string `json:"name"`
}

// readTaskFile reads name under rt when it is a regular file of at most
// maxTaskFile bytes: a FIFO answers at once (openNonblock) instead of
// waiting for a writer, a device is never read, and a symlink out of the root
// is refused by os.Root.
func readTaskFile(rt *os.Root, name string) ([]byte, error) {
	f, err := rt.OpenFile(name, os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if fi, err := f.Stat(); err != nil || !fi.Mode().IsRegular() {
		return nil, errTaskFileNotRegular
	}
	b, err := io.ReadAll(io.LimitReader(f, maxTaskFile+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxTaskFile {
		return nil, errTaskFileTooLarge
	}
	return b, nil
}

// parsePackageJSON returns the scripts of package.json in the file's order
// and its packageManager field. Scripts whose name the Tasks view cannot
// run, or whose value is no string, are counted in skipped. A file that is
// no JSON object, or whose scripts is none, has no scripts.
func parsePackageJSON(b []byte) (scripts []scriptTask, pmField string, skipped int) {
	dec := json.NewDecoder(bytes.NewReader(b))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return nil, "", 0
	}
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			return nil, "", 0
		}
		switch key {
		case "packageManager":
			var v any
			if dec.Decode(&v) != nil {
				return nil, "", 0
			}
			pmField, _ = v.(string)
		case "scripts":
			if scripts, skipped, err = decodeScripts(dec); err != nil {
				return nil, "", 0
			}
		default:
			var skip json.RawMessage
			if dec.Decode(&skip) != nil {
				return nil, "", 0
			}
		}
	}
	scripts = withHooks(scripts)
	return scripts, pmField, skipped
}

// decodeScripts reads the value of "scripts" keeping its keys' order; one
// that is no object reads as none.
func decodeScripts(dec *json.Decoder) ([]scriptTask, int, error) {
	var raw json.RawMessage
	if err := dec.Decode(&raw); err != nil {
		return nil, 0, err
	}
	in := json.NewDecoder(bytes.NewReader(raw))
	if t, err := in.Token(); err != nil || t != json.Delim('{') {
		return nil, 0, nil
	}
	var out []scriptTask
	skipped := 0
	seen := map[string]bool{}
	// raw is valid JSON: reading its tokens cannot fail.
	for in.More() {
		key, _ := in.Token()
		var v any
		in.Decode(&v)
		name, _ := key.(string)
		cmd, isString := v.(string)
		if !isString || !validTaskName(name) || len(out) >= maxTaskItems {
			skipped++
			continue
		}
		if seen[name] {
			// A repeated key: the JSON parsers npm and pnpm use keep the last.
			for i := range out {
				if out[i].Name == name {
					out[i].Command, out[i].Truncated = cutCommand(cmd)
				}
			}
			continue
		}
		seen[name] = true
		c, cut := cutCommand(cmd)
		out = append(out, scriptTask{Name: name, Command: c, Truncated: cut})
	}
	return out, skipped, nil
}

// cutCommand cuts a script's command for the list at maxScriptShown bytes,
// on a character boundary.
func cutCommand(cmd string) (string, bool) {
	if len(cmd) <= maxScriptShown {
		return cmd, false
	}
	cut := cmd[:maxScriptShown]
	for !utf8.ValidString(cut) {
		cut = cut[:len(cut)-1]
	}
	return cut, true
}

// withHooks names each script's pre and post scripts.
func withHooks(scripts []scriptTask) []scriptTask {
	has := map[string]bool{}
	for _, s := range scripts {
		has[s.Name] = true
	}
	for i, s := range scripts {
		for _, h := range []string{"pre" + s.Name, "post" + s.Name} {
			if has[h] {
				scripts[i].Hooks = append(scripts[i].Hooks, h)
			}
		}
	}
	return scripts
}

// detectPackageManager picks what runs the scripts: the packageManager
// field ("pnpm@9.1.0"), else the lockfile in the root, else npm.
func detectPackageManager(rt *os.Root, field string) string {
	name, _, _ := strings.Cut(field, "@")
	switch name {
	case "pnpm", "yarn", "npm", "bun":
		return name
	}
	for _, l := range []struct{ file, pm string }{
		{"pnpm-lock.yaml", "pnpm"},
		{"yarn.lock", "yarn"},
		{"bun.lock", "bun"},
		{"bun.lockb", "bun"},
	} {
		if _, err := rt.Lstat(l.file); err == nil {
			return l.pm
		}
	}
	return "npm"
}

// makefileNames are the files make reads, in the order it looks for them.
var makefileNames = []string{"GNUmakefile", "makefile", "Makefile"}

// pickMakefile returns the file make would read in the root, as the
// directory names it, "" for none. On a file system that ignores case
// (macOS, Windows) make's "makefile" opens a "Makefile": the name listed is
// the one shown.
func pickMakefile(rt *os.Root) string {
	d, err := rt.Open(".")
	if err != nil {
		return ""
	}
	defer d.Close()
	names, _ := d.Readdirnames(-1)
	for _, n := range makefileNames {
		if slices.Contains(names, n) {
			return n
		}
	}
	for _, n := range makefileNames {
		if _, err := rt.Lstat(n); err != nil {
			continue
		}
		if i := slices.IndexFunc(names, func(e string) bool { return strings.EqualFold(e, n) }); i >= 0 {
			return names[i]
		}
	}
	return ""
}

// makeDirectives start a line that is no rule.
var makeDirectives = map[string]bool{
	"ifeq": true, "ifneq": true, "ifdef": true, "ifndef": true, "else": true, "endif": true,
	"include": true, "-include": true, "sinclude": true, "export": true, "unexport": true,
	"override": true, "define": true, "endef": true, "vpath": true, "private": true,
}

// parseMakeTargets lists the explicit targets of a Makefile, in order and
// once each, without running make: a rule's line (not a recipe: no leading
// tab) whose first ':' comes before any '=' and is not the ':' of ':=',
// '::=' or ':::='. Special targets (.PHONY), patterns (%) and names built
// from variables ($) are left out; names the Tasks view cannot run are
// counted in skipped.
func parseMakeTargets(b []byte) (targets []makeTarget, skipped int) {
	text := strings.ReplaceAll(string(b), "\r\n", "\n")
	// A backslash at the end of a line continues it.
	text = strings.ReplaceAll(text, "\\\n", " ")
	seen := map[string]bool{}
	inDefine := false
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "\t") {
			continue
		}
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = line[:i]
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if inDefine {
			inDefine = fields[0] != "endef"
			continue
		}
		if makeDirectives[fields[0]] {
			// "override define", "export define" open a block too.
			inDefine = fields[0] == "define" || len(fields) > 1 && fields[1] == "define"
			continue
		}
		colon := strings.IndexByte(line, ':')
		// A rule's targets built by a function or variable ($(info a:b),
		// $(OBJ):) are no name to list.
		if colon < 0 || strings.ContainsRune(line[:colon], '=') || strings.Contains(line[:colon], "$") {
			continue
		}
		if rest := strings.TrimLeft(line[colon:], ":"); strings.HasPrefix(rest, "=") {
			continue
		}
		for _, name := range strings.Fields(line[:colon]) {
			if strings.HasPrefix(name, ".") || strings.Contains(name, "%") || seen[name] {
				continue
			}
			seen[name] = true
			if !validTaskName(name) || len(targets) >= maxTaskItems {
				skipped++
				continue
			}
			targets = append(targets, makeTarget{name})
		}
	}
	return targets, skipped
}
