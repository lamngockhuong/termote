//go:build !windows

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"sync/atomic"
	"time"
)

// herdrProtocol is the socket protocol version this backend was written
// against (herdr 0.9.1). Another version still works if the fields used here
// did not change; it only makes health report degraded.
const herdrProtocol = 22

// Herdr rejects requests of about 1 MiB and more. Input is split so that a
// chunk made only of control bytes, which JSON escapes to 6 bytes each, still
// fits.
const (
	herdrMaxRequest = 1 << 20
	herdrMaxReply   = 16 << 20 // a session.snapshot of a busy session is ~100 KiB
	herdrTextChunk  = 128 * 1024
)

// herdrError is an {"error":{code,message}} reply.
type herdrError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *herdrError) Error() string { return "herdr " + e.Code + ": " + e.Message }

// herdrRPC talks to the herdr server socket (a named pipe on Windows). The
// server answers one request per connection, except events.subscribe which
// keeps it open.
type herdrRPC struct {
	socket string
	seq    atomic.Uint64
}

type herdrRequest struct {
	ID     string `json:"id"`
	Method string `json:"method"`
	Params any    `json:"params"`
}

type herdrReply struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *herdrError     `json:"error"`
}

// dial connects and writes one request line. The caller reads the replies.
func (c *herdrRPC) dial(ctx context.Context, method string, params any) (net.Conn, error) {
	if params == nil {
		params = struct{}{}
	}
	line, err := json.Marshal(herdrRequest{ID: strconv.FormatUint(c.seq.Add(1), 10), Method: method, Params: params})
	if err != nil {
		return nil, err
	}
	if len(line) >= herdrMaxRequest {
		return nil, fmt.Errorf("herdr %s request too large (%d bytes)", method, len(line))
	}
	conn, err := dialHerdr(ctx, c.socket)
	if err != nil {
		return nil, err
	}
	if dl, ok := ctx.Deadline(); ok {
		conn.SetDeadline(dl)
	}
	if _, err := conn.Write(append(line, '\n')); err != nil {
		conn.Close()
		return nil, err
	}
	return conn, nil
}

// call sends one request and decodes the result into out (if not nil).
func (c *herdrRPC) call(ctx context.Context, method string, params, out any) error {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, muxTimeout)
		defer cancel()
	}
	conn, err := c.dial(ctx, method, params)
	if err != nil {
		return err
	}
	defer conn.Close()
	// Close on cancel so a blocked read returns.
	stop := context.AfterFunc(ctx, func() { conn.SetDeadline(time.Now()) })
	defer stop()
	reply, err := readHerdrReply(bufio.NewReaderSize(conn, 64*1024))
	if err != nil {
		return herdrReadError(ctx, method, err)
	}
	if reply.Error != nil {
		return reply.Error
	}
	if out != nil {
		if err := json.Unmarshal(reply.Result, out); err != nil {
			return fmt.Errorf("herdr %s: decode result: %w", method, err)
		}
	}
	return nil
}

// herdrReadError is the error of call when reading the reply failed.
func herdrReadError(ctx context.Context, method string, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	// The socket deadline equals ctx's and can fire first. A named pipe
	// reports it as its own timeout error, not os.ErrDeadlineExceeded.
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return fmt.Errorf("herdr %s: %w", method, context.DeadlineExceeded)
	}
	return fmt.Errorf("herdr %s: %w", method, err)
}

// readHerdrReply reads one NDJSON line, bounded by herdrMaxReply.
func readHerdrReply(r *bufio.Reader) (herdrReply, error) {
	var line []byte
	for {
		chunk, isPrefix, err := r.ReadLine()
		if err != nil {
			return herdrReply{}, err
		}
		line = append(line, chunk...)
		if len(line) > herdrMaxReply {
			return herdrReply{}, errors.New("reply too large")
		}
		if !isPrefix {
			break
		}
	}
	var reply herdrReply
	if err := json.Unmarshal(line, &reply); err != nil {
		return herdrReply{}, fmt.Errorf("decode reply: %w", err)
	}
	if reply.Error == nil && reply.Result == nil {
		return herdrReply{}, errors.New("reply has neither result nor error")
	}
	return reply, nil
}

type herdrPong struct {
	Version  string `json:"version"`
	Protocol int    `json:"protocol"`
}

func (c *herdrRPC) ping(ctx context.Context) (herdrPong, error) {
	var p herdrPong
	err := c.call(ctx, "ping", nil, &p)
	return p, err
}
