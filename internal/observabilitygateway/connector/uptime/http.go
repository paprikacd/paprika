package uptime

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net/http"
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
	limit      int
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

func (b *backend) call(ctx context.Context, procedure string, body rpcRequest, target any) error {
	encoded, err := json.Marshal(body)
	if err != nil {
		return errors.New("uptime request could not be encoded")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(b.config.Endpoint, "/")+procedure, bytes.NewReader(encoded))
	if err != nil {
		return errors.New("uptime request could not be created")
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
		return errors.New("uptime read failed")
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // The bounded response is consumed; close is best effort.
	return decodeResponse(response, target)
}

func decodeResponse(response *http.Response, target any) error {
	switch response.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized, http.StatusForbidden:
		return connector.ErrForbidden
	case http.StatusNotFound, http.StatusNotImplemented:
		return connector.ErrNotAvailable
	default:
		return errors.New("uptime read returned an unsuccessful status")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(body) > maxResponseBytes {
		return errors.New("uptime response exceeded its read budget")
	}
	if err := json.Unmarshal(body, target); err != nil {
		return errors.New("uptime response was not a valid application record")
	}
	return nil
}
