package main

import (
	"errors"
	"hash/fnv"
	"math"
	"strconv"
	"strings"
)

// errClusterNotFound is the one sentence GetCluster reveals for an unknown
// name. It names no namespace and no cluster, so the endpoint cannot be used to
// probe which clusters exist outside a caller's scope.
var errClusterNotFound = errors.New("cluster not found")

// errPipelineRunNotFound is the equivalent for a pipeline run identifier this
// fixture never minted.
var errPipelineRunNotFound = errors.New("pipeline run not found")

var errPipelineNotFound = errors.New("pipeline not found")

// consoleHash is a stable FNV-1a over an identity. Every synthesized figure is
// derived from it rather than from a counter or a clock, so a field is a pure
// function of the object it describes: the same application yields the same
// commit, owner and latency on every run and in every process, which is what
// makes a Playwright assertion able to name a value.
func consoleHash(values ...string) uint32 {
	digest := fnv.New32a()
	for index, value := range values {
		if index != 0 {
			// The separator stops ("ab","c") and ("a","bc") colliding, which
			// would otherwise give two different applications one identity.
			_, _ = digest.Write([]byte{0})
		}
		_, _ = digest.Write([]byte(value))
	}
	return digest.Sum32()
}

// consoleSpread maps a hash onto [low, high]. It is the only place a synthetic
// numeric range is defined, so no call site can accidentally emit a value
// outside the band the console was designed against.
func consoleSpread(seed uint32, low, high int) int {
	if high <= low {
		return low
	}
	// The modulus is taken in uint32 and folded back through a bounded int, so
	// the result provably lands in [low, high] on any word size.
	span := countU32(high - low + 1)
	return low + int(int64(seed%span))
}

// countU32, countU64 and weightI32 narrow a counted int to the width the wire
// uses. Every input here is a bounded synthetic count, so the clamp can never
// fire; it exists so the conversion is provably safe rather than merely
// believed to be, which is the same standard the rest of the repo holds
// integer narrowing to.
func countU32(value int) uint32 {
	if value < 0 {
		return 0
	}
	if value > math.MaxUint32 {
		return math.MaxUint32
	}
	return uint32(value)
}

func countU64(value int) uint64 {
	if value < 0 {
		return 0
	}
	return uint64(value)
}

func weightI32(value int) int32 {
	if value < math.MinInt32 {
		return math.MinInt32
	}
	if value > math.MaxInt32 {
		return math.MaxInt32
	}
	return int32(value)
}

// fixtureApplicationIndex recovers the seed index behind an application name so
// synthesized detail agrees with the projected application it describes: the
// lifecycle vector, the drift list and the rollout outcome all come from the
// same fixtureStateFor(index) the CRs were built from. A name this fixture
// never seeded still gets a stable variant rather than an error, because the
// console must be able to render a detail view for anything the fleet index
// hands it.
func fixtureApplicationIndex(name string) int {
	if name == fixtureApplicationName(0) {
		return 0
	}
	if suffix, found := strings.CutPrefix(name, "application-"); found {
		if index, err := strconv.Atoi(suffix); err == nil && index >= 0 {
			return index
		}
	}
	return int(consoleHash(name) % 5)
}

// encodeFixtureCursor and decodeFixtureCursor define the fixture's paging
// token. It is a plain offset because the underlying slices are immutable for
// the lifetime of the process, so an offset cannot skip or repeat a record the
// way it would over a mutable set.
func encodeFixtureCursor(offset int) string {
	return "offset-" + strconv.Itoa(offset)
}

// decodeFixtureCursor treats anything it did not mint as the first page. A
// fixture must not fail a request over a token shape, and there is no token
// this server emits that it cannot read back.
func decodeFixtureCursor(cursor string) int {
	suffix, found := strings.CutPrefix(cursor, "offset-")
	if !found {
		return 0
	}
	offset, err := strconv.Atoi(suffix)
	if err != nil || offset < 0 {
		return 0
	}
	return offset
}
