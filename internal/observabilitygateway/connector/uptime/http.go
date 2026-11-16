package uptime

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"time"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

const (
	servicesRPC      = "/uptimeapi.v1.ServiceService/ListServices"
	checksRPC        = "/uptimeapi.v1.CheckService/ListCheckSummaries"
	securityRPC      = "/uptimeapi.v1.CheckResultService/ListSecuritySummaries"
	alertsRPC        = "/uptimeapi.v1.AlertService/ListAlertEvents"
	sloRPC           = "/uptimeapi.v1.ServiceService/GetSLODashboard"
	reliabilityRPC   = "/uptimeapi.v1.ReliabilityInsightsService/GetReliabilityInsights"
	maxResponseBytes = 2 << 20
)

// readCacheTTL is deliberately short. A dashboard's widgets run within seconds
// of each other, and a longer window would serve stale SLO data. query_dashboard
// runs its distinct queries one after another, so this TTL, not concurrent
// coalescing, is what collapses its repeated SLO reads.
const readCacheTTL = 15 * time.Second

// reads coalesces identical upstream reads and keeps successful response bodies
// for readCacheTTL. Keys cover the URL, canonical body, credential identity,
// config headers and TLS mode, so no caller can see another caller's result.
var reads = newCoalescer[[]byte](maxCachedEntries, func(body []byte) int { return len(body) })

// errInvalidRecord is returned when a 200 body does not decode into the shape
// the operation expects. Such a body is never kept.
var errInvalidRecord = errors.New("uptime response was not a valid application record")

var transport = &http.Transport{
	Proxy:        http.ProxyFromEnvironment,
	MaxIdleConns: 16, MaxIdleConnsPerHost: 4,
	IdleConnTimeout: 90 * time.Second, TLSHandshakeTimeout: 5 * time.Second,
	ResponseHeaderTimeout: 10 * time.Second,
}

//nolint:gosec // Explicit operator opt-in matches the existing shared connector HTTP configuration.
var insecureTransport = func() *http.Transport {
	result := transport.Clone()
	result.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	return result
}()

type backend struct {
	config     *config
	credential string
	// identity digests the caller's raw credential document. It is part of
	// every read-cache key, so callers with different credentials never share.
	identity string
	limit    int
}

type pageRequest struct {
	PageSize int `json:"pageSize"`
}

type rpcRequest struct {
	OrgID        string       `json:"orgId"`
	Page         *pageRequest `json:"page,omitempty"`
	WindowDays   int          `json:"windowDays,omitempty"`
	StatusFilter string       `json:"statusFilter,omitempty"`
}

func (b *backend) listRequest() rpcRequest {
	return rpcRequest{OrgID: b.config.OrgID, Page: &pageRequest{PageSize: b.limit}}
}

// call performs one cached, coalesced read and decodes it into target.
func (b *backend) call(ctx context.Context, procedure string, body rpcRequest, target any) error {
	endpoint, encoded, err := b.request(procedure, body)
	if err != nil {
		return err
	}
	key, err := b.readKey(endpoint, encoded)
	if err != nil {
		return errors.New("uptime request could not be encoded")
	}
	raw, err := reads.do(ctx, key, queryTimeout, func(fetchCtx context.Context) ([]byte, time.Duration, error) {
		body, fetchErr := b.fetch(fetchCtx, endpoint, encoded)
		if fetchErr != nil {
			return nil, 0, fetchErr
		}
		// Check the shape before the body can be kept, so a wrong-shaped 200 is
		// an error for every waiter and is never cached.
		if checkErr := checkRecord(body, target); checkErr != nil {
			return nil, 0, checkErr
		}
		return body, readCacheTTL, nil
	})
	if err != nil {
		return err
	}
	return decodeRecord(raw, target)
}

// callUncached performs one read with no coalescing and no cache. It is for
// authorization gates, which must reflect the current membership.
func (b *backend) callUncached(ctx context.Context, procedure string, body rpcRequest, target any) error {
	endpoint, encoded, err := b.request(procedure, body)
	if err != nil {
		return err
	}
	raw, err := b.fetch(ctx, endpoint, encoded)
	if err != nil {
		return err
	}
	return decodeRecord(raw, target)
}

func (b *backend) request(procedure string, body rpcRequest) (endpoint string, encoded []byte, err error) {
	encoded, err = json.Marshal(body)
	if err != nil {
		return "", nil, errors.New("uptime request could not be encoded")
	}
	return strings.TrimRight(b.config.Endpoint, "/") + procedure, encoded, nil
}

// checkRecord reports whether body decodes into a value shaped like target.
func checkRecord(body []byte, target any) error {
	probe := reflect.New(reflect.TypeOf(target).Elem()).Interface()
	return decodeRecord(body, probe)
}

func decodeRecord(body []byte, target any) error {
	if err := json.Unmarshal(body, target); err != nil {
		return errInvalidRecord
	}
	return nil
}

// readKey identifies one logical read. Credentials and header values are
// represented by a digest or are already part of the hashed structure, so the
// key never stores the bearer token.
func (b *backend) readKey(endpoint string, encoded []byte) (string, error) {
	return digestOf(struct {
		Endpoint        string            `json:"endpoint"`
		Body            json.RawMessage   `json:"body"`
		Identity        string            `json:"identity"`
		Headers         map[string]string `json:"headers"`
		InsecureSkipTLS bool              `json:"insecureSkipTls"`
	}{endpoint, encoded, b.identity, b.config.Headers, b.config.InsecureSkipTLS})
}

// fetch performs one upstream read and returns its bounded, validated body.
func (b *backend) fetch(ctx context.Context, endpoint string, encoded []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return nil, errors.New("uptime request could not be created")
	}
	for key, value := range b.config.Headers {
		req.Header.Set(key, value)
	}
	req.Header.Set("Authorization", "Bearer "+b.credential)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connect-Protocol-Version", "1")
	client := &http.Client{Transport: transport, CheckRedirect: httphelp.RejectRedirect}
	if b.config.InsecureSkipTLS {
		client.Transport = insecureTransport
	}
	response, err := httphelp.DoReadRequest(req, client)
	if err != nil {
		return nil, errors.New("uptime read failed")
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // The bounded response is consumed; close is best effort.
	return readResponse(response)
}

func readResponse(response *http.Response) ([]byte, error) {
	switch response.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized, http.StatusForbidden:
		return nil, connector.ErrForbidden
	case http.StatusNotFound, http.StatusNotImplemented:
		return nil, connector.ErrNotAvailable
	default:
		return nil, errors.New("uptime read returned an unsuccessful status")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(body) > maxResponseBytes {
		return nil, errors.New("uptime response exceeded its read budget")
	}
	if !json.Valid(body) {
		return nil, errors.New("uptime response was not a valid application record")
	}
	return body, nil
}
