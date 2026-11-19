//go:build race

package insights

// raceEnabled is true under the race detector, whose instrumentation changes how much
// a build allocates and how fast it runs, so allocation budgets are checked only without it
// and time budgets are wider under it.
const raceEnabled = true
