package main

import (
	"context"
	"time"
)

// slotRetry is how often a view-only request waiting in waitSlot looks
// again for a slot it may take.
const slotRetry = 20 * time.Millisecond

// takeSlot takes one of slots without waiting. A view-only request never
// takes the last free one, so a view-only device cannot hold a pool shared
// server-wide and turn full clients away as busy. The caller gives the slot
// back.
func takeSlot(slots chan struct{}, viewOnly bool) bool {
	select {
	case slots <- struct{}{}:
	default:
		return false
	}
	if viewOnly && len(slots) == cap(slots) {
		<-slots
		return false
	}
	return true
}

// waitSlot takes one of slots, waiting until ctx is done. A view-only
// request waits, as takeSlot refuses, until a slot other than the last is
// free. The caller gives the slot back.
func waitSlot(ctx context.Context, slots chan struct{}, viewOnly bool) bool {
	if !viewOnly {
		select {
		case slots <- struct{}{}:
			return true
		case <-ctx.Done():
			return false
		}
	}
	for {
		if takeSlot(slots, true) {
			return true
		}
		select {
		case <-time.After(slotRetry):
		case <-ctx.Done():
			return false
		}
	}
}
