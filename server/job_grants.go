package main

// grant is the user's leave, given ahead from the PWA, for the orchestrator
// to answer one narrow kind of permission dialog of one job's agent
// (agent_delegate.go). It is pinned to the agent and, for file edits, the
// directory the job had when it was made.
type grant struct {
	ID      string     `json:"id"`
	Job     string     `json:"job,omitempty"`
	Agent   jobAgent   `json:"agent"`
	Dir     string     `json:"dir,omitempty"`
	Kind    string     `json:"kind"`
	Prefix  string     `json:"prefix,omitempty"`
	Created string     `json:"created"`
	Expires string     `json:"expires"`
	Revoked string     `json:"revoked,omitempty"`
	Uses    []grantUse `json:"uses,omitempty"`
}

// grantUse is one dialog answered under a grant.
type grantUse struct {
	At      string `json:"at"`
	Command string `json:"command,omitempty"`
	Path    string `json:"path,omitempty"`
}
