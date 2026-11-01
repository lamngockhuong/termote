//go:build !linux && !darwin && !freebsd && !windows

package main

import "errors"

// diskStatsOf has no statfs to call here.
func diskStatsOf(string, string) (diskStats, error) {
	return diskStats{}, errors.New("unsupported")
}
