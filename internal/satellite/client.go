package satellite

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// ErrResync means the receiver has no matching sequence baseline. The caller
// must open a new session and send a complete snapshot.
var ErrResync = errors.New("satellite receiver requires a new snapshot")

// Client sends bounded, compressed reports over a pooled, TLS-verified HTTP
// connection. It never follows redirects, which prevents a configured ingress
// from forwarding a cluster credential to a different endpoint.
type Client struct {
	endpoint  string
	tokenFile string
	http      *http.Client
}

// NewClient constructs the outbound transport. Plain HTTP is allowed only for
// literal loopback addresses and localhost, to support local development.
//
//nolint:gocritic // Copy configuration at the public constructor boundary so caller mutation cannot affect construction.
func NewClient(config Config) (*Client, error) {
	if config.TokenFile == "" {
		return nil, errors.New("satellite token file is required")
	}
	u, err := reportURL(config.ControlPlaneURL)
	if err != nil {
		return nil, err
	}
	transport, err := reportTransport(config.CAFile)
	if err != nil {
		return nil, err
	}
	return &Client{
		endpoint: u.String(), tokenFile: config.TokenFile,
		http: &http.Client{Transport: transport, Timeout: 30 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	}, nil
}

// parseControlPlaneURL validates the configured origin. Both transports share
// it so the POST path and the stream cannot disagree about what is an
// acceptable endpoint — a credential must never travel to a scheme or host the
// other transport would refuse.
func parseControlPlaneURL(base string) (*url.URL, error) {
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("satellite control plane URL must be an absolute URL without credentials, query or fragment")
	}
	if u.Scheme != "https" && (u.Scheme != "http" || !loopbackHost(u.Hostname())) {
		return nil, errors.New("satellite control plane URL requires HTTPS")
	}
	return u, nil
}

func reportURL(base string) (*url.URL, error) {
	u, err := parseControlPlaneURL(base)
	if err != nil {
		return nil, err
	}
	u.Path = strings.TrimRight(u.Path, "/") + ReportPath
	u.RawPath = ""
	return u, nil
}

func reportTransport(caFile string) (*http.Transport, error) {
	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return nil, errors.New("satellite default HTTP transport is unavailable")
	}
	transport := base.Clone()
	transport.ForceAttemptHTTP2 = true
	transport.MaxIdleConnsPerHost = 2
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	if caFile != "" {
		roots, err := reportRoots(caFile)
		if err != nil {
			return nil, err
		}
		transport.TLSClientConfig.RootCAs = roots
	}
	return transport, nil
}

func reportRoots(caFile string) (*x509.CertPool, error) {
	pem, err := os.ReadFile(caFile) //nolint:gosec // CA path is supplied by the operator's local configuration, never by a remote request.
	if err != nil {
		return nil, fmt.Errorf("read satellite CA file: %w", err)
	}
	roots, err := x509.SystemCertPool()
	if err != nil || roots == nil {
		roots = x509.NewCertPool()
	}
	if !roots.AppendCertsFromPEM(pem) {
		return nil, errors.New("satellite CA file contains no certificates")
	}
	return roots, nil
}

func loopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// EncodeReport enforces the receiver's uncompressed size limit before gzip.
// The same encoded bytes can be retried after an ambiguous network failure.
func EncodeReport(report *Report) ([]byte, error) {
	if len(report.Applications) > MaxApplications {
		return nil, fmt.Errorf("satellite report exceeds %d applications", MaxApplications)
	}
	data, err := json.Marshal(report)
	if err != nil {
		return nil, fmt.Errorf("encode satellite report: %w", err)
	}
	if len(data) > MaxReportBytes {
		return nil, fmt.Errorf("satellite report exceeds %d uncompressed bytes", MaxReportBytes)
	}
	var compressed bytes.Buffer
	w, err := gzip.NewWriterLevel(&compressed, gzip.BestSpeed)
	if err != nil {
		return nil, fmt.Errorf("create satellite compressor: %w", err)
	}
	if _, err = w.Write(data); err != nil {
		return nil, fmt.Errorf("compress satellite report: %w", err)
	}
	if err = w.Close(); err != nil {
		return nil, fmt.Errorf("finish satellite report: %w", err)
	}
	if compressed.Len() > MaxReportBytes {
		return nil, fmt.Errorf("satellite report exceeds %d compressed bytes", MaxReportBytes)
	}
	return compressed.Bytes(), nil
}

// SendEncoded sends one pre-encoded report. A mounted token is read for each
// attempt, so rotations do not require restarting the agent or its session.
func (c *Client) SendEncoded(ctx context.Context, body []byte) error {
	token, err := os.ReadFile(c.tokenFile)
	if err != nil {
		return errors.New("read satellite token file failed")
	}
	credential := strings.TrimSpace(string(token))
	if credential == "" || strings.ContainsAny(credential, "\r\n\t ") {
		return errors.New("satellite token file must contain one non-empty bearer token")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return errors.New("build satellite report request failed")
	}
	req.Header.Set("Authorization", "Bearer "+credential)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Content-Encoding", "gzip")
	resp, err := c.http.Do(req)
	if err != nil {
		// URL errors include the remote URL; diagnostics intentionally retain
		// only the cause category rather than connection configuration.
		if ctx.Err() != nil {
			return fmt.Errorf("satellite report cancelled: %w", ctx.Err())
		}
		return errors.New("satellite report transport failed")
	}
	defer func() { _ = resp.Body.Close() }()                    //nolint:errcheck // Read-only response cleanup does not affect delivery acknowledgement.
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096)) //nolint:errcheck // Bounded draining is only for connection reuse; HTTP status determines acknowledgement.
	if resp.StatusCode == http.StatusConflict {
		return ErrResync
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("satellite report returned HTTP %d", resp.StatusCode)
	}
	return nil
}

// Close releases idle connections during graceful agent shutdown.
func (c *Client) Close() { c.http.CloseIdleConnections() }
