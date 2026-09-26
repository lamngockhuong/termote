package main

import (
	"fmt"
	"net/http"
	"strings"
	"time"
)

func (c *cli) cmdHealth(args []string) error {
	port := 0
	fs := c.newFlagSet("health")
	fs.IntVar(&port, "port", 0, "")
	if _, err := parseArgs(fs, args); err != nil {
		return flagErr(err)
	}
	saved, _ := c.loadConfig()
	if saved == nil {
		saved = &savedConfig{}
	}
	if port == 0 {
		port = saved.Port
	}
	if port == 0 {
		port = c.defaultPort()
	}
	mux := saved.Mux
	if mux == "" {
		mux = "tmux"
	}

	c.heading("Termote Health Check")
	where := "localhost"
	if saved.LAN {
		where = "LAN"
	}
	if rt := c.runningContainerRuntime(); rt != "" {
		where += ", container (" + rt + ")"
		mux = "tmux"
	}

	failed := 0
	client := &http.Client{Timeout: 2 * time.Second}
	check := func(label, path string) {
		status := httpStatus(client, fmt.Sprintf("http://127.0.0.1:%d%s", port, path))
		desc := describeStatus(status)
		if status == http.StatusOK || status == http.StatusUnauthorized {
			fmt.Fprintf(c.out, "  %s %s - %s (%s)\n", c.paint(ansiGreen, "[OK]"), label, desc, where)
			return
		}
		fmt.Fprintf(c.out, "  %s %s - %s\n", c.paint(ansiRed, "[--]"), label, desc)
		failed++
	}
	check(fmt.Sprintf("tmux-api :%d", port), "/")
	check("API /api/mux/health", "/api/mux/health")
	fmt.Fprintf(c.out, "  Backend: %s\n\n", mux)

	if failed > 0 {
		fmt.Fprintln(c.out, c.paint(ansiYellow, fmt.Sprintf("%d check(s) failed", failed)))
		return &exitError{code: 1}
	}
	fmt.Fprintln(c.out, c.paint(ansiGreen, "All services healthy!"))
	return nil
}

// runningContainerRuntime returns the runtime whose termote container is up.
func (c *cli) runningContainerRuntime() string {
	for _, rt := range []string{"docker", "podman"} {
		if _, err := c.run.LookPath(rt); err != nil {
			continue
		}
		out, err := c.run.Output("", nil, rt, "ps", "-q", "--filter", "name="+containerName)
		if err == nil && strings.TrimSpace(string(out)) != "" {
			return rt
		}
	}
	return ""
}

// httpStatus returns the status code, or 0 when nothing answers.
func httpStatus(client *http.Client, url string) int {
	resp, err := client.Get(url)
	if err != nil {
		return 0
	}
	resp.Body.Close()
	return resp.StatusCode
}

func describeStatus(code int) string {
	switch code {
	case 0:
		return "not running"
	case http.StatusOK:
		return "running"
	case http.StatusUnauthorized:
		return "running (auth)"
	}
	return fmt.Sprintf("HTTP %d", code)
}
