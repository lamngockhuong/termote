package main

// cliVersion is this binary's version. release-please updates it for each
// release, and the release build also sets it from the tag
// (-ldflags "-X main.cliVersion=<v>"), so a pre-release or a release made by
// hand reports its own tag too.
var cliVersion = "1.6.0" // x-release-please-version
