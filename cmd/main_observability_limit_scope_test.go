package main

import (
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/benebsworth/paprika/internal/observabilitygateway"
)

// An edge refusal names the edge scope on its 429.
func TestRejectObservabilityAdmissionNamesEdgeScope(t *testing.T) {
	t.Parallel()
	recorder := httptest.NewRecorder()
	rejectObservabilityAdmission(recorder, 2)
	assert.Equal(t, 429, recorder.Code)
	assert.Equal(t, string(observabilitygateway.ScopeEdge), recorder.Header().Get(observabilitygateway.LimitScopeHeader))
}
