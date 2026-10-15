package observabilitygateway

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestConsentHandlerRequiresRid(t *testing.T) {
	t.Parallel()

	h := ConsentHandler("/observe")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/observe/consent", nil))
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestConsentHandlerRejectsPost(t *testing.T) {
	t.Parallel()

	h := ConsentHandler("/observe")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/observe/consent?rid=abc", strings.NewReader("{}")))
	require.Equal(t, http.StatusMethodNotAllowed, rec.Code)
}

func TestConsentHandlerServesPage(t *testing.T) {
	t.Parallel()

	h := ConsentHandler("/observe")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/observe/consent?rid=abc123", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Header().Get("Content-Type"), "text/html")

	body, err := io.ReadAll(rec.Result().Body)
	require.NoError(t, err)
	page := string(body)

	// The page drives the shared server's authorize flow under the gateway's
	// route prefix, with the mirrored decision values.
	require.Contains(t, page, `"/observe"`)
	require.Contains(t, page, "/authorize/pending?rid=")
	require.Contains(t, page, "/authorize/consent")
	require.Contains(t, page, `"approve"`)
	require.Contains(t, page, `"deny"`)
	// The decision POST's success path must navigate to consentResponse's
	// camelCase redirectTo field (internal/api/mcp/oauth.go). A key
	// mismatch passes every server-side check and then renders "Something
	// went wrong" on a flow that actually minted a code — the 2026-10-14
	// omega incident this assertion guards.
	require.Contains(t, page, "resp.redirectTo")
	// The rid lands as a JSON-marshaled string literal.
	require.Contains(t, page, `var gatewayRid = "abc123";`)
	// Branding and self-help surface: the embedded paprika mark (data URI,
	// no external asset requests), the deployment-derived MCP endpoint
	// block the script fills in, and the documentation link.
	require.Contains(t, page, "data:image/png;base64,")
	require.Contains(t, page, `id="endpoint"`)
	require.Contains(t, page, "github.com/paprikacd/paprika/blob/master/docs/guides/observability-gateway.md")
	// The dither texture is the Bayer-ordered 8x8 SVG tile layered over
	// the paprika gradient.
	require.Contains(t, page, "width='8' height='8'")
	require.Contains(t, page, "paprika_return_to")
}

func TestConsentHandlerRidCannotBreakOutOfScript(t *testing.T) {
	t.Parallel()

	// A rid that would close the inline script and start a new one must be
	// neutralized by JSON marshaling's <, >, & escaping.
	hostile := `</script><script>alert(1)</script>`

	h := ConsentHandler("/observe")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/observe/consent?rid="+hostile, nil))
	require.Equal(t, http.StatusOK, rec.Code)

	body, err := io.ReadAll(rec.Result().Body)
	require.NoError(t, err)
	page := string(body)

	require.NotContains(t, page, "</script><script>alert(1)</script>")
	require.Contains(t, page, `\u003c/script\u003e\u003cscript\u003ealert(1)\u003c/script\u003e`)
}

func TestConsentHandlerRoutePrefixIsEscaped(t *testing.T) {
	t.Parallel()

	h := ConsentHandler(`/observe"><script>alert(1)</script>`)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/observe/consent?rid=abc", nil))
	require.Equal(t, http.StatusOK, rec.Code)

	body, err := io.ReadAll(rec.Result().Body)
	require.NoError(t, err)
	require.NotContains(t, string(body), `</script><script>alert(1)</script>`)
}
