package main

import (
	"fmt"
	"os"
	"strings"
)

// cmdPanel is the Herdr plugin's popup: the server's status, every address,
// a QR code of the link to the session the popup was opened on, and keys to
// open or copy that link and to start, stop or restart the server. Outside a
// terminal it prints the same once and exits.
func (c *cli) cmdPanel(args []string) error {
	if len(args) > 0 {
		return usageError("panel takes no arguments")
	}
	sel, err := c.herdrContext()
	fromHerdr := err == nil
	if !fromHerdr {
		sel = deepLink{}
	}
	msg := ""
	for {
		info := c.resolveLink(sel, fromHerdr)
		c.drawPanel(info, fromHerdr, msg)
		msg = ""
		if !c.interactive || !c.outTTY || c.readKey == nil {
			return nil
		}
		key, err := c.readKey()
		if err != nil {
			return nil
		}
		running := info.report.Running
		switch key {
		case 'q', 'Q', 27, 3, 4: // Esc, Ctrl-C, Ctrl-D
			return nil
		case 'o', 'O':
			if running {
				msg = c.panelResult("Opened the link in the browser", c.openURL(info.url))
			}
		case 'c', 'C':
			if running {
				via, err := c.copyText(info.url)
				msg = c.panelResult("Copied the link ("+via+")", err)
			}
		case 's', 'S':
			if !running {
				c.panelRun("start")
			}
		case 'x', 'X':
			if running {
				c.panelRun("stop")
			}
		case 'r', 'R':
			if running {
				c.panelRun("restart")
			}
		}
	}
}

func (c *cli) panelResult(ok string, err error) string {
	if err != nil {
		return c.paint(ansiRed, err.Error())
	}
	return c.paint(ansiGreen, ok)
}

// panelRun runs `termote <cmd>` in the popup, so its output and any question
// it asks show there, then waits for a key before drawing the panel again.
func (c *cli) panelRun(cmd string) {
	fmt.Fprintf(c.out, "\n%s\n\n", c.paint(ansiCyan, "$ termote "+cmd))
	if err := c.run.Run("", withoutHerdrPaneEnv(os.Environ()), c.stableExe(), cmd); err != nil {
		fmt.Fprintf(c.out, "\n%s\n", c.paint(ansiRed, "termote "+cmd+" failed"))
	}
	fmt.Fprintf(c.out, "\n%s", c.paint(ansiDim, "Press a key to go back"))
	c.readKey()
}

func (c *cli) drawPanel(info linkInfo, fromHerdr bool, msg string) {
	if c.interactive && c.outTTY {
		fmt.Fprint(c.out, "\033[H\033[2J")
	}
	r := info.report
	fmt.Fprintf(c.out, "%s", c.paint(ansiBold, "Termote"))
	if !r.Running {
		fmt.Fprintf(c.out, "  %s\n\n", c.paint(ansiRed, "not running"))
		fmt.Fprintf(c.out, "%s\n", c.paint(ansiDim, "s start  q close"))
		c.panelMessage(msg)
		return
	}
	details := []string{}
	if r.Version != "" {
		details = append(details, "v"+r.Version)
	}
	if r.Backend != "" {
		details = append(details, r.Backend)
	}
	details = append(details, r.Status)
	fmt.Fprintf(c.out, "  %s\n\n", c.paint(ansiGreen, strings.Join(details, " · ")))
	fmt.Fprintf(c.out, "%s\n", c.paint(ansiCyan, info.url))
	fmt.Fprint(c.out, qrText(info.url))
	fmt.Fprintf(c.out, "Local: %s\n", r.URLs.Local)
	for _, u := range r.URLs.LAN {
		fmt.Fprintf(c.out, "LAN: %s\n", u)
	}
	if r.URLs.Tailscale != "" {
		fmt.Fprintf(c.out, "Tailscale: %s\n", r.URLs.Tailscale)
	}
	notes := info.notes
	if !fromHerdr {
		notes = append(notes, "Not opened from Herdr: the link opens the home screen")
	}
	for _, n := range notes {
		fmt.Fprintf(c.out, "%s\n", c.paint(ansiYellow, n))
	}
	fmt.Fprintf(c.out, "\n%s\n", c.paint(ansiDim, "o open  c copy  x stop  r restart  q close"))
	c.panelMessage(msg)
}

func (c *cli) panelMessage(msg string) {
	if msg != "" {
		fmt.Fprintln(c.out, msg)
	}
}
