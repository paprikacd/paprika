package source

import (
	"os"
	"testing"
)

// TestMain pins the tests written for the go-git mirror, which build a
// GitSource without a Backend, to that backend. The CLI backend's tests name
// it on each source.
func TestMain(m *testing.M) {
	// The tests' origins are local repositories.
	allowLocalGitRepos = true
	s := defaultGitSettings()
	s.backend = GitBackendGoGit
	installGitSettings(s)
	os.Exit(m.Run())
}

// installGitSettings replaces the process-wide settings and limits.
func installGitSettings(s gitSettings) {
	gitSettingsMu.Lock()
	defer gitSettingsMu.Unlock()
	gitSettingsVal, gitSettingsSet = s, true
	gitLimiterVal = newGitLimiter(s)
}

// withGitSettings changes the settings for one test.
func withGitSettings(t *testing.T, change func(*gitSettings)) {
	t.Helper()
	before := currentGitSettings()
	s := before
	change(&s)
	installGitSettings(s)
	t.Cleanup(func() { installGitSettings(before) })
}

// forgetCLIState drops the CLI backend's per-mirror state (revision answers,
// init flags, locks), as a restart does. The cache on disk is untouched.
func forgetCLIState() {
	cliRepos.Lock()
	cliRepos.m = map[string]*cliRepo{}
	cliRepos.Unlock()
}

// withGitBinary makes the CLI backend look for git under name, for one test.
func withGitBinary(t *testing.T, name string) {
	t.Helper()
	reprobe := func(bin string) {
		gitCLIProbe.Lock()
		gitBinary, gitCLIProbe.done = bin, false
		gitCLIProbe.Unlock()
	}
	before := gitBinary
	reprobe(name)
	t.Cleanup(func() { reprobe(before) })
}
