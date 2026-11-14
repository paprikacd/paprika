//go:build race

package insights

// raceEnabled is true under the race detector, whose instrumentation changes how much
// a build allocates, so allocation budgets are checked only without it.
const raceEnabled = true
