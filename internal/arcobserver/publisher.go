package arcobserver

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

type Publisher interface {
	Publish(context.Context, Source, Observation) error
}

type HTTPPublisher struct {
	endpoint, projectID, tokenFile string
	client                         *http.Client
	sources                        map[string]Source
}

// NewHTTPPublisher accepts only a mounted credential file. No Kubernetes
// Secret API is used, and redirects never carry a bearer to another endpoint.
func NewHTTPPublisher(cfg Config, tokenFile string, client *http.Client) (*HTTPPublisher, error) {
	raw, err := json.Marshal(cfg)
	if err != nil {
		return nil, ErrInvalidConfig
	}
	validated, err := ParseConfig(string(raw))
	if err != nil || len(validated.Sources) == 0 || !filepath.IsAbs(tokenFile) {
		return nil, ErrInvalidConfig
	}
	cfg = validated
	sources := make(map[string]Source, len(cfg.Sources))
	for _, s := range cfg.Sources {
		sources[s.PoolName] = s
	}
	if client == nil {
		client = &http.Client{Transport: http.DefaultTransport}
	}
	c := *client
	c.Timeout = PublishDeadline
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &HTTPPublisher{endpoint: cfg.Endpoint, projectID: cfg.ProjectID, tokenFile: tokenFile, client: &c, sources: sources}, nil
}

func (p *HTTPPublisher) Publish(ctx context.Context, s Source, o Observation) error {
	if allowed, ok := p.sources[s.PoolName]; !ok || allowed != s {
		return ErrRejected
	}
	info, err := os.Stat(p.tokenFile)
	if err != nil || !info.Mode().IsRegular() {
		return ErrRejected
	}
	file, err := os.Open(p.tokenFile)
	if err != nil {
		return ErrRejected
	}
	raw, err := io.ReadAll(io.LimitReader(file, 4097))
	_ = file.Close()
	if err != nil || len(raw) > 4096 {
		return ErrRejected
	}
	token := strings.TrimSpace(string(raw))
	if len(token) < 20 || !strings.HasPrefix(token, "cf_sa_") || strings.ContainsAny(token, " \t\r\n") {
		return ErrRejected
	}
	body, err := json.Marshal(o)
	if err != nil {
		return ErrRejected
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint+"/api/fleet/pools/"+s.PoolName+"/observations", bytes.NewReader(body))
	if err != nil {
		return ErrRejected
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-cuttle-project", p.projectID)
	resp, err := p.client.Do(req)
	if err != nil {
		return ErrRejected
	}
	// Never log or interpret response bodies: upstream errors may contain secrets.
	_ = resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return ErrDenied
	}
	if resp.StatusCode != http.StatusNoContent {
		return ErrRejected
	}
	return nil
}
