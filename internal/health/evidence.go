package health

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func probeTransportFailure(err error) *HTTPResult {
	reason, message := "RequestFailed", "The HTTP request failed before a complete response was received."
	var dns *net.DNSError
	var cert *tls.CertificateVerificationError
	var unknownCA x509.UnknownAuthorityError
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		reason, message = "Timeout", "The HTTP probe exceeded its timeout."
	case errors.Is(err, context.Canceled):
		reason, message = "Canceled", "The HTTP probe was canceled before it completed."
	case errors.As(err, &dns):
		reason, message = "DNSFailure", "The probe hostname could not be resolved."
	case errors.As(err, &cert), errors.As(err, &unknownCA):
		reason, message = "TLSFailure", "The server's TLS certificate could not be verified."
	case errors.Is(err, syscall.ECONNREFUSED):
		reason, message = "ConnectionRefused", "The target refused the connection. Check the Service endpoints and listening port."
	default:
		var network net.Error
		if errors.As(err, &network) && network.Timeout() {
			reason, message = "Timeout", "The HTTP probe exceeded its timeout."
		}
	}
	// Transport errors include request URLs, credentials and query values. Persist
	// a classified explanation, never err.Error().
	return &HTTPResult{Reason: reason, Body: message}
}

// CaptureEvidence keeps a small diagnostic trail independent of SLO accounting.
// A successful observation replaces the current response but not recent issues.
func CaptureEvidence(check api.HealthCheck, previous *api.HealthCheckResult, result EvalResult, current *api.HealthCheckResult) {
	current.Message, _ = sanitizeEvidence(result.Message, check.HTTPProbe, 1024)
	if result.HTTPResult != nil {
		current.HTTPStatusCode = result.HTTPResult.StatusCode
		current.HTTPBody, current.BodyTruncated = sanitizeEvidence(result.HTTPResult.Body, check.HTTPProbe, 4096)
		current.Reason = result.HTTPResult.Reason
	}
	if result.Status != api.HealthHealthy && current.Reason == "" {
		current.Reason, current.Message = evaluationFailure(check, result, current.Message)
	}
	retainFailureEvidence(previous, current)
}

func evaluationFailure(check api.HealthCheck, result EvalResult, message string) (reason, detail string) {
	if check.HTTPProbe != nil && result.HTTPResult != nil {
		expected := check.HTTPProbe.ExpectedStatus
		if expected == 0 {
			expected = 200
		}
		if result.HTTPResult.StatusCode != expected {
			return "UnexpectedStatus", fmt.Sprintf("Expected HTTP %d, received HTTP %d", expected, result.HTTPResult.StatusCode)
		}
	}
	if result.Status == api.HealthUnknown {
		return "EvaluationError", message
	}
	return "ExpressionFailed", message
}

func retainFailureEvidence(previous, current *api.HealthCheckResult) {
	if current.CheckedAt == nil {
		return
	}
	cutoff := current.CheckedAt.Add(-30 * 24 * time.Hour)
	carryRecentFailures(previous, current, cutoff)
	if current.Status != api.HealthHealthy {
		body, truncated := sanitizeEvidence(current.HTTPBody, nil, 2048)
		failure := api.HealthCheckFailure{CheckedAt: *current.CheckedAt, Status: current.Status, Reason: current.Reason,
			Message: current.Message, HTTPStatusCode: current.HTTPStatusCode, DurationMillis: current.DurationMillis,
			HTTPBody: body, BodyTruncated: truncated || current.BodyTruncated}
		current.RecentFailures = append([]api.HealthCheckFailure{failure}, current.RecentFailures...)
		if len(current.RecentFailures) > 5 {
			current.RecentFailures = current.RecentFailures[:5]
		}
	}
}

func carryRecentFailures(previous, current *api.HealthCheckResult, cutoff time.Time) {
	if previous != nil && previous.ConfigurationHash == current.ConfigurationHash {
		for _, failure := range previous.RecentFailures {
			if !failure.CheckedAt.Time.Before(current.CheckedAt.Time) || failure.CheckedAt.Time.Before(cutoff) {
				continue
			}
			current.RecentFailures = append(current.RecentFailures, failure)
			if len(current.RecentFailures) == 5 {
				break
			}
		}
	}
}

var credentialField = regexp.MustCompile(`(?i)(password|passwd|secret|token|authorization|cookie|api[_-]?key|credential|private[_-]?key)`)
var bearerValue = regexp.MustCompile(`(?i)\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=~-]+`)
var credentialAssignment = regexp.MustCompile(`(?i)((?:password|passwd|secret|token|api[_-]?key|authorization|cookie)\s*[:=]\s*)[^\s,;"'}<]+`)
var evidenceURL = regexp.MustCompile(`\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\s<>"']+`)

func sanitizeEvidence(raw string, probe *api.HTTPProbe, limit int) (string, bool) {
	var value any
	if json.Unmarshal([]byte(raw), &value) == nil {
		redactFields(value)
		if encoded, err := json.Marshal(value); err == nil {
			raw = string(encoded)
		}
	}
	for _, secret := range probeSecrets(probe) {
		if secret != "" {
			raw = strings.ReplaceAll(raw, secret, "[redacted]")
		}
	}
	raw = bearerValue.ReplaceAllString(raw, "$1 [redacted]")
	raw = credentialAssignment.ReplaceAllString(raw, "${1}[redacted]")
	raw = evidenceURL.ReplaceAllStringFunc(raw, func(s string) string {
		u, err := url.Parse(s)
		if err != nil {
			return "[redacted URL]"
		}
		u.User = nil
		u.RawQuery = ""
		u.ForceQuery = false
		u.Fragment = ""
		return u.String()
	})
	raw = strings.ToValidUTF8(raw, "�")
	if len(raw) <= limit {
		return raw, false
	}
	for limit > 0 && !utf8.RuneStart(raw[limit]) {
		limit--
	}
	return raw[:limit], true
}

func redactFields(value any) {
	switch v := value.(type) {
	case map[string]any:
		for key, child := range v {
			if credentialField.MatchString(key) {
				v[key] = "[redacted]"
			} else {
				redactFields(child)
			}
		}
	case []any:
		for _, child := range v {
			redactFields(child)
		}
	}
}

func probeSecrets(probe *api.HTTPProbe) []string {
	if probe == nil {
		return nil
	}
	secrets := make([]string, 0, len(probe.Headers)+4)
	for key, value := range probe.Headers {
		if !credentialField.MatchString(key) {
			continue
		}
		secrets = append(secrets, value)
		if parts := strings.Fields(value); len(parts) == 2 {
			secrets = append(secrets, parts[1])
		}
	}
	u, err := url.Parse(probe.URL)
	if err != nil {
		return secrets
	}
	if u.User != nil {
		password, _ := u.User.Password()
		secrets = append(secrets, password, u.User.Username())
	}
	for _, values := range u.Query() {
		secrets = append(secrets, values...)
	}
	return secrets
}
