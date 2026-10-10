package main

import (
	"fmt"
	"log"
	"strconv"
	"strings"
)

// auditf writes one "audit:" line to the server log: the event, then each
// key with its value quoted, so a device name holding a quote, an "=" or a
// space can never pass for another key. kv alternates keys (constants of
// the caller) and values. Never pass a token, a pairing code, a password or
// a cookie.
//
// The log is the user's own and any full device can delete it: the lines
// help notice a pairing, they prove nothing.
func auditf(event string, kv ...any) {
	log.Print(auditLine(event, kv...))
}

func auditLine(event string, kv ...any) string {
	var b strings.Builder
	b.WriteString("audit: ")
	b.WriteString(event)
	for i := 0; i+1 < len(kv); i += 2 {
		v := kv[i+1]
		if ids, ok := v.([]string); ok {
			v = strings.Join(ids, ",")
		}
		fmt.Fprintf(&b, " %s=%s", kv[i], strconv.Quote(fmt.Sprint(v)))
	}
	return b.String()
}

// auditBy names who did something in an audit line: a paired device by its
// id, anyone else signed in with the password.
func auditBy(a authInfo) string {
	if a.Kind == authDevice {
		return "device:" + a.DeviceID
	}
	return pairedByPassword
}
