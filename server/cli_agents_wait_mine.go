package main

import "fmt"

// termote agents wait --mine: wait --job on every unfinished job made from
// this command's pane (the jobs of jobs --mine), read from the ledger at
// each poll, so the orchestrator need not carry the list from one wait to
// the next, and a job it started or gave more work since is waited for too.

const waitMineUsage = "usage: termote agents wait --mine [--timeout <duration>]"

// waitMineArg: args name wait --mine (as --mine, -mine or --mine=true).
func waitMineArg(args []string) bool {
	for _, a := range args {
		switch a {
		case "--mine", "-mine", "--mine=true", "-mine=true":
			return true
		}
	}
	return false
}

func (c *cli) agentsWaitMine(args []string) error {
	timeout := agentsJobsWait
	mine, job := false, false
	fs := c.newFlagSet("agents wait")
	fs.DurationVar(&timeout, "timeout", agentsJobsWait, "")
	fs.BoolVar(&mine, "mine", false, "")
	fs.BoolVar(&job, "job", false, "")
	fs.String("after", "", "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	switch {
	case !mine:
		return usageError("wait --mine=false waits for nothing; name the jobs or panes instead\n%s\n%s", waitMineUsage, waitJobUsage)
	case job || len(pos) != 0 || fs.Lookup("after").Value.String() != "":
		// A pane in two waits would have its turn reported to one only.
		return usageError("--mine already waits on every job made from this pane; it takes no job ids, panes or --after\n%s", waitMineUsage)
	case timeout <= 0:
		return usageError("--timeout must be more than 0\n%s", waitMineUsage)
	}
	port, err := c.agentsPort()
	if err != nil {
		return err
	}
	s, err := c.agentsSnapshot(port)
	if err != nil {
		return err
	}
	self, pane := c.selfKey(s), c.selfPaneID(s)
	if self == "" {
		return fmt.Errorf("--mine needs to know this command's pane, and its environment does not say for sure (herdr-core, psmux, Windows, or another pane's variables); name the jobs instead: termote agents wait --job <id>... (see termote agents jobs)")
	}
	return c.waitJobs(port, jobWait{self: self, pane: pane}, timeout)
}
