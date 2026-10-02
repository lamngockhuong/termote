package main

import (
	"bytes"
	"encoding/binary"
	"path/filepath"
	"strings"
)

// Parsers for the macOS process sources, kept free of build tags so they are
// tested on every OS.

// parseProcArgs2 splits a kern.procargs2 buffer: argc, then the exec path,
// then argc arguments, then the environment, each NUL-terminated (with
// padding NULs after the exec path).
func parseProcArgs2(b []byte) (execPath string, args, env []string, ok bool) {
	if len(b) < 4 {
		return "", nil, nil, false
	}
	argc := int(binary.LittleEndian.Uint32(b))
	fields := bytes.Split(b[4:], []byte{0})
	execPath = string(fields[0])
	i := 1 // skip the exec path
	for i < len(fields) && len(fields[i]) == 0 {
		i++
	}
	for ; i < len(fields) && len(args) < argc; i++ {
		args = append(args, string(fields[i]))
	}
	for ; i < len(fields); i++ {
		if len(fields[i]) > 0 {
			env = append(env, string(fields[i]))
		}
	}
	return execPath, args, env, true
}

// envGetter looks a key up in KEY=VALUE pairs; the first one wins.
func envGetter(env []string) func(string) string {
	return func(key string) string {
		for _, kv := range env {
			if k, v, ok := strings.Cut(kv, "="); ok && k == key {
				return v
			}
		}
		return ""
	}
}

// parseLsofWriteFiles reads `lsof -F0an` output: one set of NUL-terminated
// fields per line, 'p' starting a process and 'f' a file, with 'a' the access
// mode (r, w, u) and 'n' the name. It keeps the absolute names opened for
// writing whose base name passes match; a name holding a control character
// (lsof escapes some, not all) is dropped.
func parseLsofWriteFiles(out []byte, match func(name string) bool) []procFile {
	var files []procFile
	for _, line := range bytes.Split(out, []byte{'\n'}) {
		var mode, name string
		for _, f := range bytes.Split(line, []byte{0}) {
			if len(f) == 0 {
				continue
			}
			switch f[0] {
			case 'a':
				mode = string(f[1:])
			case 'n':
				name = string(f[1:])
			}
		}
		if (mode != "w" && mode != "u") || !filepath.IsAbs(name) || strings.ContainsFunc(name, isControl) || !match(filepath.Base(name)) {
			continue
		}
		files = append(files, procFile{path: name})
	}
	return files
}

func isControl(r rune) bool { return r < 0x20 || r == 0x7f }
