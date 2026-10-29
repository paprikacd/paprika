//go:build !unix

package source

import "os/exec"

// isolateProcessGroup leaves exec.CommandContext's default: cancellation
// kills git itself.
func isolateProcessGroup(*exec.Cmd) {}

func killProcessGroup(int) error { return nil }
