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
	Publish(context.Context, *Source, *Observation) error
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

func (p *HTTPPublisher) Publish(ctx context.Context, s *Source, o *Observation) error {
	if allowed, ok := p.sources[s.PoolName]; !ok || allowed != *s {
		return ErrRejected
	}
	token, err := p.readToken()
	if err != nil {
		return err
	}
	req, err := p.request(ctx, s.PoolName, token, o)
	if err != nil {
		return err
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return ErrRejected
	}
	// Never log or interpret response bodies: upstream errors may contain secrets.
	closeErr := resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return ErrDenied
	}
	if closeErr != nil || resp.StatusCode != http.StatusNoContent {
		return ErrRejected
	}
	return nil
}

func (p *HTTPPublisher) readToken() (string, error) {
	info, err := os.Stat(p.tokenFile)
	if err != nil || !info.Mode().IsRegular() {
		return "", ErrRejected
	}
	file, err := os.Open(p.tokenFile)
	if err != nil {
		return "", ErrRejected
	}
	raw, err := io.ReadAll(io.LimitReader(file, 4097))
	closeErr := file.Close()
	if err != nil || closeErr != nil || len(raw) > 4096 {
		return "", ErrRejected
	}
	token := strings.TrimSpace(string(raw))
	if !validToken(token) {
		return "", ErrRejected
	}
	return token, nil
}

func validToken(token string) bool {
	return len(token) >= 20 && strings.HasPrefix(token, "cf_sa_") && !strings.ContainsAny(token, " \t\r\n")
}

func (p *HTTPPublisher) request(ctx context.Context, poolName, token string, o *Observation) (*http.Request, error) {
	body, err := json.Marshal(o)
	if err != nil {
		return nil, ErrRejected
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint+"/api/fleet/pools/"+poolName+"/observations", bytes.NewReader(body))
	if err != nil {
		return nil, ErrRejected
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-cuttle-project", p.projectID)
	return req, nil
}
