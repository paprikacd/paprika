package insights

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
)

// maxProviderErrorBody bounds the part of a failed provider response that is
// read for its error class. Only the errorType field is ever decoded.
const maxProviderErrorBody = 4 << 10

// providerErrorTypes are the Prometheus errorType values a failure may keep.
// Any other value is dropped, so the provider's text never reaches a caller.
var providerErrorTypes = map[string]bool{
	"bad_data": true, "execution": true, "timeout": true, "canceled": true,
	"internal": true, "unavailable": true, "not_found": true,
}

// providerTimeoutError is a direct provider call that timed out in transport.
// It is a timeout to the caller and keeps the shared upstream text.
type providerTimeoutError struct{}

func (e *providerTimeoutError) Error() string { return errUpstream.Error() }
func (e *providerTimeoutError) Unwrap() error { return errUpstream }

// providerErrorType returns the bounded errorType of a failed provider body, or
// an empty string. It reads at most maxProviderErrorBody bytes.
func providerErrorType(body io.Reader) string {
	data, err := io.ReadAll(io.LimitReader(body, maxProviderErrorBody))
	if err != nil {
		return ""
	}
	var response struct {
		ErrorType string `json:"errorType"`
	}
	if json.Unmarshal(data, &response) != nil || !providerErrorTypes[response.ErrorType] {
		return ""
	}
	return response.ErrorType
}

// transportFailure classifies a failed direct provider call. A timeout keeps its
// class; everything else is the shared upstream failure.
func transportFailure(ctx context.Context, err error) error {
	var netErr net.Error
	if ctx.Err() == nil && errors.As(err, &netErr) && netErr.Timeout() {
		return &providerTimeoutError{}
	}
	return errUpstream
}

// classifyQueryFailure maps a failed query to the public error vocabulary. It is
// the one classifier for /api/query, query receipts, query_dashboard and the
// dry-run checks. It reads error classes and statuses, never provider text.
func classifyQueryFailure(err error) *DashboardQueryError {
	if failure := classifyContextFailure(err); failure != nil {
		return failure
	}
	var timeout *providerTimeoutError
	if errors.As(err, &timeout) {
		return timeoutFailure()
	}
	var direct *providerHTTPError
	if errors.As(err, &direct) {
		return classifyProviderFailure(direct, err)
	}
	var remote *observeError
	if errors.As(err, &remote) {
		if failure := classifyObserveStatus(remote.status); failure != nil {
			if failure.Code == "rate_limited" {
				failure.LimitScope = remote.scope
			}
			return failure
		}
	}
	// The status is not carried in the code. A capacity, budget or gateway
	// status is still marked transient for the dry run.
	return &DashboardQueryError{Code: "provider_error", Message: "The provider query could not be completed.", transient: directProviderTransient(err)}
}

// classifyContextFailure names a cancelled or expired context, exhausted query
// capacity and an unknown provider. It returns nil for any other error.
func classifyContextFailure(err error) *DashboardQueryError {
	switch {
	case errors.Is(err, context.Canceled):
		return canceledFailure()
	case errors.Is(err, context.DeadlineExceeded):
		return timeoutFailure()
	case errors.Is(err, errQueryCapacity):
		return rateLimitedFailure()
	case errors.Is(err, ErrNotFound):
		return providerNotFoundFailure()
	}
	return nil
}

// classifyObserveStatus maps a shared gateway's status. It returns nil for a
// status the shared path does not classify.
func classifyObserveStatus(status int) *DashboardQueryError {
	switch status {
	case http.StatusForbidden, http.StatusUnauthorized:
		return forbiddenFailure()
	case http.StatusTooManyRequests:
		return rateLimitedFailure()
	case http.StatusRequestTimeout:
		// The shared path answers 408 for a request its caller cancelled, not for a
		// provider that ran out of time. Only 504 names a timeout.
		return canceledFailure()
	case http.StatusGatewayTimeout:
		return timeoutFailure()
	case http.StatusBadRequest:
		return invalidQueryFailure()
	case http.StatusServiceUnavailable:
		// The shared path answers 503 when the provider is not configured or cannot
		// serve the request. Both are permanent until the provider changes, so they
		// name the unavailable source rather than a transient failure.
		return providerNotFoundFailure()
	case http.StatusBadGateway:
		// The gateway itself failed: it could not be reached, or it answered with a
		// server error. That is not a provider fault, and a retry can clear it.
		return gatewayUnavailableFailure()
	}
	return nil
}

func gatewayUnavailableFailure() *DashboardQueryError {
	return &DashboardQueryError{Code: "gateway_unavailable", Message: "The observability gateway could not complete the query. Retry shortly.", transient: true}
}

// classifyProviderFailure maps a direct provider's answer by status and bounded
// errorType: a rejected query, a budget, a capacity limit or an unavailable source.
func classifyProviderFailure(direct *providerHTTPError, err error) *DashboardQueryError {
	switch {
	case direct.errorType == "timeout" && direct.status == http.StatusServiceUnavailable:
		return timeoutFailure()
	case (direct.errorType == "bad_data" || direct.errorType == "execution") && direct.status == http.StatusOK:
		return invalidQueryFailure()
	}
	switch direct.status {
	case http.StatusBadRequest, http.StatusUnprocessableEntity:
		return invalidQueryFailure()
	case http.StatusUnauthorized, http.StatusForbidden:
		return forbiddenFailure()
	case http.StatusRequestTimeout, http.StatusGatewayTimeout:
		return timeoutFailure()
	case http.StatusTooManyRequests:
		return rateLimitedFailure()
	}
	return &DashboardQueryError{Code: "provider_error", Message: "The provider query could not be completed.", transient: directProviderTransient(err)}
}

// forbiddenFailure covers both refusals: the caller lacks access, or the
// provider refused the credentials Insights holds for it. The text names both.
func forbiddenFailure() *DashboardQueryError {
	return &DashboardQueryError{Code: "forbidden", Message: "The query provider refused access. Check the caller's permissions or the provider credentials."}
}

func providerNotFoundFailure() *DashboardQueryError {
	return &DashboardQueryError{Code: "provider_not_found", Message: "The query provider is unavailable or not configured."}
}

func canceledFailure() *DashboardQueryError {
	return &DashboardQueryError{Code: "canceled", Message: "Dashboard query execution was canceled."}
}

func timeoutFailure() *DashboardQueryError {
	return &DashboardQueryError{Code: "timeout", Message: "The provider query exceeded its time budget."}
}

func rateLimitedFailure() *DashboardQueryError {
	return &DashboardQueryError{Code: "rate_limited", Message: "Query capacity is currently exhausted; retry shortly."}
}

func invalidQueryFailure() *DashboardQueryError {
	return &DashboardQueryError{Code: "invalid_query", Message: "The provider rejected the resolved query."}
}

// directProviderTransient reports whether a direct provider answered with a
// gateway, capacity or unavailable status, which a retry can clear. A plain 500
// stays a finding for the dry run. Timeout and rate-limit codes are transient by
// their own code, so they carry no flag here.
func directProviderTransient(err error) bool {
	var direct *providerHTTPError
	if !errors.As(err, &direct) {
		return false
	}
	switch direct.status {
	case http.StatusTooManyRequests, http.StatusRequestTimeout, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	}
	return false
}
