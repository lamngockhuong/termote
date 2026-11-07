package main

import (
	_ "embed"
	"fmt"
)

// agentGuide is the guide for coding agents that install and run termote.
// The website publishes the same file as /agents.md.
//
//go:embed agent-guide.md
var agentGuide string

// cmdHelp prints the command help, or one help topic. A topic is static text
// built into the binary: it reads no config and makes no request.
func (c *cli) cmdHelp(args []string) error {
	if len(args) == 0 {
		c.printHelp()
		return nil
	}
	if len(args) == 1 && args[0] == "agent" {
		fmt.Fprint(c.out, agentGuide)
		return nil
	}
	c.printHelp()
	return usageError("unknown help topic: %s (topics: agent)", args[0])
}
