package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

func (c *cli) cmdLogs(args []string) error {
	lines := defaultLogLines
	fs := c.newFlagSet("logs")
	fs.IntVar(&lines, "lines", defaultLogLines, "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	service := "all"
	if len(pos) > 0 {
		service = pos[0]
	}
	// 0.x accepted the line count as a second argument.
	if len(pos) > 1 {
		if n, err := strconv.Atoi(pos[1]); err == nil && n > 0 {
			lines = n
		}
	}
	switch service {
	case "tmux-api", "api":
		return c.printLogs("tmux-api*.log", lines, "No tmux-api logs")
	case "all", "":
		return c.printLogs("*.log", lines, "")
	case "follow", "tail", "-f":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
		defer stop()
		return c.followLogs(ctx, lines, 300*time.Millisecond)
	case "clean":
		return c.cleanLogs()
	case "ttyd":
		c.infof("ttyd was removed in 1.0.0; the terminal now runs inside tmux-api (see: termote logs tmux-api)")
		return nil
	}
	return usageError("unknown log service: %s (use: tmux-api, all, follow, clean)", service)
}

func (c *cli) logFiles(pattern string) []string {
	files, _ := filepath.Glob(filepath.Join(c.logDir(), pattern))
	sort.Strings(files)
	return files
}

func (c *cli) printLogs(pattern string, lines int, emptyWarn string) error {
	files := c.logFiles(pattern)
	if len(files) == 0 {
		if emptyWarn != "" {
			c.warnf("%s (log dir: %s)", emptyWarn, c.logDir())
		} else {
			fmt.Fprintf(c.out, "(no logs in %s)\n", c.logDir())
		}
		return nil
	}
	for _, f := range files {
		fmt.Fprintln(c.out, c.paint(ansiBold, "=== "+strings.TrimSuffix(filepath.Base(f), ".log")+" ==="))
		if t := tailFile(f, lines); t != "" {
			fmt.Fprintln(c.out, t)
		} else {
			fmt.Fprintln(c.out, "(empty)")
		}
		fmt.Fprintln(c.out)
	}
	return nil
}

// followLogs prints the last lines of every log, then new lines as they are
// appended, prefixed with the file name, until ctx ends. It reads the files
// itself, so no `tail` is needed on Windows.
func (c *cli) followLogs(ctx context.Context, lines int, every time.Duration) error {
	offsets := map[string]int64{}
	partial := map[string]string{}
	emit := func(f, text string) {
		name := strings.TrimSuffix(filepath.Base(f), ".log")
		text = partial[f] + text
		parts := strings.Split(text, "\n")
		partial[f] = parts[len(parts)-1]
		for _, l := range parts[:len(parts)-1] {
			fmt.Fprintf(c.out, "[%s] %s\n", name, strings.TrimRight(l, "\r"))
		}
	}
	files := c.logFiles("*.log")
	if len(files) == 0 {
		c.warnf("No logs to follow yet (log dir: %s); waiting...", c.logDir())
	} else {
		c.infof("Following logs (Ctrl+C to stop)...")
	}
	for _, f := range files {
		if t := tailFile(f, lines); t != "(no log)" && t != "" {
			emit(f, t+"\n")
		}
		if st, err := os.Stat(f); err == nil {
			offsets[f] = st.Size()
		}
	}
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-tick.C:
		}
		for _, f := range c.logFiles("*.log") {
			st, err := os.Stat(f)
			if err != nil {
				continue
			}
			off := offsets[f]
			if st.Size() < off { // truncated or cleaned
				off, partial[f] = 0, ""
			}
			if st.Size() == off {
				continue
			}
			fh, err := os.Open(f)
			if err != nil {
				continue
			}
			fh.Seek(off, io.SeekStart)
			b, _ := io.ReadAll(io.LimitReader(fh, st.Size()-off))
			fh.Close()
			offsets[f] = off + int64(len(b))
			emit(f, string(b))
		}
	}
}

func (c *cli) cleanLogs() error {
	files := c.logFiles("*.log")
	if len(files) == 0 {
		c.infof("No logs to clean")
		return nil
	}
	var total int64
	for _, f := range files {
		if st, err := os.Stat(f); err == nil {
			total += st.Size()
		}
		if err := removeFile(f); err != nil {
			c.warnf("Could not remove %s: %v", f, err)
		}
	}
	c.infof("Logs cleaned (was: %.1f KB)", float64(total)/1024)
	return nil
}
