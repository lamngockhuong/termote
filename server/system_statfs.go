//go:build linux || darwin || freebsd

package main

import "golang.org/x/sys/unix"

// diskStatsOf measures the filesystem holding path.
func diskStatsOf(path, label string) (diskStats, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return diskStats{}, err
	}
	bs := uint64(st.Bsize)
	if st.Blocks == 0 {
		return diskStats{}, errSysFormat
	}
	return newDiskStats(label, uint64(st.Blocks)*bs, uint64(st.Bfree)*bs, uint64(st.Bavail)*bs), nil
}
