//go:build !linux && !darwin && !windows

package main

import (
	"errors"
	"os"
)

// Agent sessions are not looked up on other systems.
const agentProcSupported = false

// codexProcSupported is false: a Codex pane is not looked up here (no file
// listing per process), so it has no Chat view.
const codexProcSupported = false

func procExeBase(int) string                           { return "" }
func procArgs(int) []string                            { return nil }
func procCodexHome(int) (string, bool)                 { return "", false }
func procWriteFiles(int, func(string) bool) []procFile { return nil }
func procAllPIDs() []int                               { return nil }

func procChildrenFunc() (func(int) []int, error) { return nil, errors.New("unsupported") }
func procStartTime(int) (string, bool)           { return "", false }
func procClaudeDir(int) (string, bool)           { return "", false }
func claudePIDDomain() string                    { return "" }
func fileIdentity(os.FileInfo) string            { return "" }
func procForeground(int) bool                    { return false }
