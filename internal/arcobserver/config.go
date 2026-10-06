// Package arcobserver publishes read-only ARC inventory. It neither registers
// agents nor changes runner admission, pods, scale sets, nodes or permissions.
package arcobserver

import (
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const PollInterval = 20 * time.Second
const ReadDeadline = 8 * time.Second
const PublishDeadline = 3 * time.Second

type Config struct {
	Endpoint  string       `json:"endpoint"`
	ProjectID string       `json:"projectId"`
	Sources   []Source     `json:"sources"`
	Usage     *UsageConfig `json:"usage,omitempty"`
}

type Source struct {
	PoolName             string `json:"poolName"`
	RunnerNamespace      string `json:"runnerNamespace"`
	SystemNamespace      string `json:"systemNamespace"`
	ControllerDeployment string `json:"controllerDeployment"`
	// Maxima are assertions of existing configuration, never desired changes.
	ExpectedMinRunners int64 `json:"expectedMinRunners"`
	ExpectedMaxRunners int64 `json:"expectedMaxRunners"`
}

var identifier = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$`)
var kubeName = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$`)
var nodeName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$`)
var ErrInvalidConfig = errors.New("invalid ARC observer configuration")
var ErrIncomplete = errors.New("ARC inventory read incomplete")
var ErrRejected = errors.New("ARC observation publication rejected")
var ErrDenied = errors.New("ARC observation publication authorization denied")

func ParseConfig(raw string) (Config, error) {
	var cfg Config
	if strings.TrimSpace(raw) == "" {
		return cfg, nil
	}
	if len(raw) > 32768 {
		return cfg, ErrInvalidConfig
	}
	d := json.NewDecoder(strings.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&cfg) != nil || d.Decode(new(any)) != io.EOF {
		return Config{}, ErrInvalidConfig
	}
	if !validConfig(&cfg) {
		return Config{}, ErrInvalidConfig
	}
	cfg.Endpoint = strings.TrimSuffix(cfg.Endpoint, "/")
	return cfg, nil
}

func validOrigin(u *url.URL) bool {
	if u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Opaque != "" {
		return false
	}
	return !u.ForceQuery && (u.Path == "" || u.Path == "/") && u.RawQuery == "" && u.Fragment == ""
}

func validSource(s *Source) bool {
	if !kubeName.MatchString(s.PoolName) || !kubeName.MatchString(s.RunnerNamespace) || !kubeName.MatchString(s.SystemNamespace) || !kubeName.MatchString(s.ControllerDeployment) {
		return false
	}
	return s.ExpectedMinRunners >= 0 && s.ExpectedMaxRunners >= 1 && s.ExpectedMaxRunners <= 100 && s.ExpectedMinRunners <= s.ExpectedMaxRunners
}

func validConfig(cfg *Config) bool {
	if cfg.Usage != nil && !validUsageConfig(cfg.Usage) {
		return false
	}
	u, err := url.Parse(cfg.Endpoint)
	if err != nil || !validOrigin(u) || !identifier.MatchString(cfg.ProjectID) || len(cfg.Sources) < 1 || len(cfg.Sources) > 2 {
		return false
	}
	return validSources(cfg.Sources)
}

func validSources(sources []Source) bool {
	seen := map[string]bool{}
	for i := range sources {
		s := &sources[i]
		if !validSource(s) || seen[s.PoolName] {
			return false
		}
		seen[s.PoolName] = true
	}
	return true
}
