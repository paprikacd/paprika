// Package memlimit sets the Go soft memory limit from the container's cgroup memory
// limit, so the runtime collects garbage before the kernel OOM-kills the pod.
package memlimit

import (
	"math"
	"os"
	"runtime/debug"
	"strconv"
	"strings"
)

const (
	cgroupV2Path = "/sys/fs/cgroup/memory.max"
	cgroupV1Path = "/sys/fs/cgroup/memory/memory.limit_in_bytes"
	// percent is the share of the container limit given to the Go runtime. The rest
	// covers memory the heap limit does not count, such as goroutine stacks and the
	// page cache charged to the cgroup.
	percent = 90
	// cgroup v1 reports "no limit" as a page-aligned value near the top of int64.
	// Anything at or above this bound is treated as unlimited.
	v1Unlimited = int64(1) << 62
)

// Reader reads the named file. os.ReadFile has this shape.
type Reader func(name string) ([]byte, error)

// Limit is a soft memory limit derived from a container limit.
type Limit struct {
	// Bytes is the value passed to debug.SetMemoryLimit.
	Bytes int64
	// ContainerBytes is the cgroup limit it was derived from.
	ContainerBytes int64
	// Source is the cgroup file that held the container limit.
	Source string
}

// Compute returns the soft limit for this process. It returns false, and applies
// nothing, when GOMEMLIMIT is set to a non-empty value, when the container has no
// memory limit, and when the limit file is unreadable or does not parse. getenv and
// read are injected so the policy can be tested without a cgroup.
func Compute(getenv func(string) string, read Reader) (Limit, bool) {
	if getenv("GOMEMLIMIT") != "" {
		return Limit{}, false
	}
	if data, err := read(cgroupV2Path); err == nil {
		// A cgroup v2 file is authoritative even when it cannot be parsed. Falling
		// back to a v1 file here would apply a limit the v2 cgroup does not set.
		return fromCgroup(strings.TrimSpace(string(data)), cgroupV2Path, math.MaxInt64)
	}
	data, err := read(cgroupV1Path)
	if err != nil {
		return Limit{}, false
	}
	return fromCgroup(strings.TrimSpace(string(data)), cgroupV1Path, v1Unlimited)
}

// fromCgroup parses one limit value. The v2 literal "max" and any value at or above
// unlimitedAt mean no limit. Zero, negative and non-numeric values are not limits.
func fromCgroup(text, source string, unlimitedAt int64) (Limit, bool) {
	if text == "max" {
		return Limit{}, false
	}
	n, err := strconv.ParseInt(text, 10, 64)
	if err != nil || n <= 0 || n >= unlimitedAt {
		return Limit{}, false
	}
	// Divide first so the product cannot overflow for a limit near the top of the range.
	bytes := n / 100 * percent
	if bytes <= 0 {
		return Limit{}, false
	}
	return Limit{Bytes: bytes, ContainerBytes: n, Source: source}, true
}

// Apply sets the soft memory limit when Compute finds one and logs what it set
// through logf, which has the shape of slog.Info and logr.Logger.Info. It changes
// nothing, and logs nothing, otherwise.
func Apply(logf func(msg string, keysAndValues ...any)) {
	limit, ok := Compute(os.Getenv, os.ReadFile)
	if !ok {
		return
	}
	debug.SetMemoryLimit(limit.Bytes)
	logf("applied Go memory limit from container limit",
		"limitBytes", limit.Bytes, "containerLimitBytes", limit.ContainerBytes, "source", limit.Source)
}
