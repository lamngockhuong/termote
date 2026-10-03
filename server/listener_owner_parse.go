package main

import (
	"strconv"
	"strings"
)

// lsofUIDs returns the uid of each process in lsof -Fu output ("p<pid>",
// then "u<uid>"; other lines are file fields).
func lsofUIDs(out string) []int {
	var uids []int
	for _, line := range strings.Split(out, "\n") {
		v, ok := strings.CutPrefix(strings.TrimSpace(line), "u")
		if !ok {
			continue
		}
		uid, err := strconv.Atoi(v)
		if err != nil {
			uid = -1
		}
		uids = append(uids, uid)
	}
	return uids
}

// procNetListenerUIDs returns the uid of each socket in a /proc/net/tcp
// listing that listens (state 0A) on port.
//
//	sl  local_address rem_address   st tx_queue:rx_queue tr:tm->when retrnsmt   uid ...
//	0: 0100007F:1E00 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 ...
func procNetListenerUIDs(table string, port int) []int {
	var uids []int
	for _, line := range strings.Split(table, "\n") {
		f := strings.Fields(line)
		if len(f) < 8 || f[3] != "0A" {
			continue
		}
		_, hexPort, ok := strings.Cut(f[1], ":")
		if !ok {
			continue
		}
		p, err := strconv.ParseUint(hexPort, 16, 16)
		if err != nil || int(p) != port {
			continue
		}
		uid, err := strconv.Atoi(f[7])
		if err != nil {
			// Unreadable owner: never trusted.
			uid = -1
		}
		uids = append(uids, uid)
	}
	return uids
}
