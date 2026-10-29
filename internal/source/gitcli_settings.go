package source

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/semaphore"
	"k8s.io/apimachinery/pkg/api/resource"
	"sigs.k8s.io/controller-runtime/pkg/log"

	paprikametrics "github.com/benebsworth/paprika/internal/metrics"
)

// Environment variables that tune git fetching. The chart sets them on the
// repo server from repoServer.git and repoServer.cache.
const (
	// EnvGitBackend selects the fetch implementation: auto (default), cli or
	// go-git.
	EnvGitBackend = "PAPRIKA_GIT_BACKEND"
	// EnvGitMaxConcurrentFetches bounds the git fetches one process runs at
	// once, across every repository (default 4).
	EnvGitMaxConcurrentFetches = "PAPRIKA_GIT_MAX_CONCURRENT_FETCHES"
	// EnvGitFetchTimeout bounds one git fetch (default 10m).
	EnvGitFetchTimeout = "PAPRIKA_GIT_FETCH_TIMEOUT"
	// EnvGitCacheMaxBytes bounds the git cache on disk, as a Kubernetes
	// quantity ("20Gi"). Above it the least recently used mirrors and
	// checkouts are removed. Empty or 0 leaves the cache unbounded.
	EnvGitCacheMaxBytes = "PAPRIKA_GIT_CACHE_MAX_BYTES"
	// EnvGitCacheMinAge protects cache entries used more recently than this
	// from eviction (default 15m): a render may still be reading them.
	EnvGitCacheMinAge = "PAPRIKA_GIT_CACHE_MIN_AGE"
)

// gitSettings are the process-wide git fetch settings.
type gitSettings struct {
	backend         GitBackend
	maxFetches      int64
	maxLsRemotes    int64
	fetchTimeout    time.Duration
	lsRemoteTimeout time.Duration
	cacheMaxBytes   int64
	cacheMinAge     time.Duration
}

func defaultGitSettings() gitSettings {
	return gitSettings{
		backend:         GitBackendAuto,
		maxFetches:      4,
		maxLsRemotes:    16,
		fetchTimeout:    10 * time.Minute,
		lsRemoteTimeout: time.Minute,
		cacheMinAge:     15 * time.Minute,
	}
}

// gitSettingsFromEnv reads the settings, keeping the default for any value it
// cannot parse and reporting each such value.
func gitSettingsFromEnv(getenv func(string) string) (gitSettings, error) {
	s := defaultGitSettings()
	var errs []error
	if v := strings.TrimSpace(getenv(EnvGitBackend)); v != "" {
		switch b := GitBackend(strings.ToLower(v)); b {
		case GitBackendAuto, GitBackendCLI, GitBackendGoGit:
			s.backend = b
		default:
			errs = append(errs, fmt.Errorf("%s=%q: want auto, cli or go-git", EnvGitBackend, v))
		}
	}
	if v := strings.TrimSpace(getenv(EnvGitMaxConcurrentFetches)); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 1 {
			errs = append(errs, fmt.Errorf("%s=%q: want a positive integer", EnvGitMaxConcurrentFetches, v))
		} else {
			s.maxFetches = n
		}
	}
	errs = append(errs,
		parseEnvDuration(getenv, EnvGitFetchTimeout, &s.fetchTimeout),
		parseEnvDuration(getenv, EnvGitCacheMinAge, &s.cacheMinAge))
	if v := strings.TrimSpace(getenv(EnvGitCacheMaxBytes)); v != "" {
		q, err := resource.ParseQuantity(v)
		if err != nil || q.Sign() < 0 {
			errs = append(errs, fmt.Errorf("%s=%q: want a quantity such as 20Gi", EnvGitCacheMaxBytes, v))
		} else {
			s.cacheMaxBytes = q.Value()
		}
	}
	return s, errors.Join(errs...)
}

func parseEnvDuration(getenv func(string) string, name string, dst *time.Duration) error {
	v := strings.TrimSpace(getenv(name))
	if v == "" {
		return nil
	}
	d, err := time.ParseDuration(v)
	if err != nil || d < 0 {
		return fmt.Errorf("%s=%q: want a duration such as 10m", name, v)
	}
	*dst = d
	return nil
}

var (
	gitSettingsMu  sync.Mutex
	gitSettingsSet bool
	gitSettingsVal gitSettings
	gitLimiterVal  *gitLimiter
)

// currentGitSettings returns the settings, read from the environment on first
// use.
func currentGitSettings() gitSettings {
	gitSettingsMu.Lock()
	defer gitSettingsMu.Unlock()
	if !gitSettingsSet {
		s, err := gitSettingsFromEnv(os.Getenv)
		if err != nil {
			log.Log.WithName("git").Error(err, "Ignoring invalid git fetch settings; using defaults for them")
		}
		gitSettingsVal, gitSettingsSet = s, true
		gitLimiterVal = newGitLimiter(s)
	}
	return gitSettingsVal
}

// currentGitLimiter returns the process-wide concurrency limits.
func currentGitLimiter() *gitLimiter {
	currentGitSettings()
	gitSettingsMu.Lock()
	defer gitSettingsMu.Unlock()
	return gitLimiterVal
}

// gitLimiter bounds the git network operations of one process. Fetches into
// one mirror are also serialized by that mirror's lock, which is taken first,
// so one repository holds at most one fetch slot and a slow repository can
// never take the slots of the others.
type gitLimiter struct {
	fetches   *semaphore.Weighted
	lsRemotes *semaphore.Weighted
}

func newGitLimiter(s gitSettings) *gitLimiter {
	return &gitLimiter{
		fetches:   semaphore.NewWeighted(s.maxFetches),
		lsRemotes: semaphore.NewWeighted(s.maxLsRemotes),
	}
}

// acquire takes one slot of sem, waiting no longer than ctx allows.
func acquireSlot(ctx context.Context, sem *semaphore.Weighted) (func(), error) {
	if sem.TryAcquire(1) {
		return func() { sem.Release(1) }, nil
	}
	paprikametrics.GitFetchesWaiting.Add(ctx, 1)
	err := sem.Acquire(ctx, 1)
	paprikametrics.GitFetchesWaiting.Add(ctx, -1)
	if err != nil {
		return nil, fmt.Errorf("wait for a git fetch slot: %w", err)
	}
	return func() { sem.Release(1) }, nil
}

// minGitMajor and minGitMinor are the oldest git the CLI backend uses: 2.44
// honours GIT_NO_LAZY_FETCH, so no git command can start a fetch on its own.
const (
	minGitMajor = 2
	minGitMinor = 44
)

var (
	gitCLIOnce sync.Once
	gitCLIPath string
	errGitCLI  error
)

var gitVersionRe = regexp.MustCompile(`git version (\d+)\.(\d+)`)

// gitCLI returns the git binary the CLI backend runs, once it has checked
// that it is new enough.
func gitCLI() (string, error) {
	gitCLIOnce.Do(func() {
		gitCLIPath, errGitCLI = probeGitCLI()
	})
	return gitCLIPath, errGitCLI
}

func probeGitCLI() (string, error) {
	path, err := exec.LookPath("git")
	if err != nil {
		return "", fmt.Errorf("git CLI backend: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "version").Output() // #nosec G204 -- fixed arguments
	if err != nil {
		return "", fmt.Errorf("git CLI backend: %s version: %w", path, err)
	}
	m := gitVersionRe.FindStringSubmatch(string(out))
	if m == nil {
		return "", fmt.Errorf("git CLI backend: unrecognised %q", strings.TrimSpace(string(out)))
	}
	major, _ := strconv.Atoi(m[1]) //nolint:errcheck // the regexp matched digits
	minor, _ := strconv.Atoi(m[2]) //nolint:errcheck // the regexp matched digits
	if major < minGitMajor || (major == minGitMajor && minor < minGitMinor) {
		return "", fmt.Errorf("git CLI backend: %s is git %d.%d; it needs %d.%d or newer",
			path, major, minor, minGitMajor, minGitMinor)
	}
	return path, nil
}

// backend returns the implementation that resolves this source. Auto picks
// the git CLI when a usable git is installed. Repositories the CLI backend
// does not serve (SSH and other schemes) always use go-git; an explicit cli
// without a usable git fails the resolve rather than falling back silently.
func (g *GitSource) backend() GitBackend {
	b := g.Backend
	if b == "" {
		b = currentGitSettings().backend
	}
	if b == GitBackendGoGit || !cliServesURL(g.RepoURL) {
		return GitBackendGoGit
	}
	if b == GitBackendCLI {
		return GitBackendCLI
	}
	if _, err := gitCLI(); err != nil {
		return GitBackendGoGit
	}
	return GitBackendCLI
}

// cliServesURL reports whether the CLI backend fetches raw: HTTP(S), file://
// and local paths. These are the transports the go-git backend authenticates
// too; SSH keys were never wired to either.
func cliServesURL(raw string) bool {
	if filepath.IsAbs(raw) {
		return true
	}
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	switch u.Scheme {
	case "https", "http", "file":
		return true
	default:
		return false
	}
}
