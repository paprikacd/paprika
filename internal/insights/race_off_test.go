//go:build !race

package insights

// raceEnabled is false without the race detector. See race_on_test.go.
const raceEnabled = false
