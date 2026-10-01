//go:build !linux && !darwin && !windows

package main

import (
	"errors"
	"os"
)

// Agent sessions are not looked up on other systems.
const agentProcSupported = false

func procChildrenFunc() (func(int) []int, error) { return nil, errors.New("unsupported") }
func procStartTime(int) (string, bool)           { return "", false }
func procClaudeDir(int) (string, bool)           { return "", false }
func claudePIDDomain() string                    { return "" }
func fileIdentity(os.FileInfo) string            { return "" }
