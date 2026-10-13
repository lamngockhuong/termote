//go:build !linux && !darwin

package main

// Zellij panes are not looked up here (no Zellij backend on Windows).

func procEnviron(int) ([]string, bool) { return nil, false }

func zellijSocketOwner(string) (int, error) { return 0, errZellijServerNotFound }
