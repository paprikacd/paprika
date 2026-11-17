package apiserver

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	"github.com/benebsworth/paprika/internal/api/mcp"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

// renderThroughServer renders a manifest stream through the Render handler, as a
// client would receive it.
func renderThroughServer(t *testing.T, rendered string) (string, error) {
	t.Helper()
	scheme := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(scheme))
	srv := NewPaprikaServer(fake.NewClientBuilder().WithScheme(scheme).Build(), nil,
		WithRenderer(&fakeRenderer{manifests: []byte(rendered)}))
	resp, err := srv.Render(context.Background(), connect.NewRequest(&paprikav1.RenderRequest{
		Type: "git", SpecJson: []byte("{}"), Namespace: "shop", Name: "shop-app",
	}))
	if err != nil {
		return "", err
	}
	return string(resp.Msg.Manifests), nil
}

// requireChangedPair fails unless diff holds a removed and an added line for key,
// each carrying its side's differs marker.
func requireChangedPair(t *testing.T, diff, key string) {
	t.Helper()
	var removed, added bool
	for _, line := range strings.Split(diff, "\n") {
		if strings.HasPrefix(line, "-") && strings.Contains(line, key) && strings.Contains(line, desiredDiffersValue) {
			removed = true
		}
		if strings.HasPrefix(line, "+") && strings.Contains(line, key) && strings.Contains(line, liveDiffersValue) {
			added = true
		}
	}
	require.True(t, removed && added, "diff has no -/+ pair for %s:\n%s", key, diff)
}

// Each shape below holds Secret values in a form the node walk does not follow on
// its own: a duplicate key, an alias or anchor, a merge key, or a kind that the
// controller reads differently. None of the values may reach the output, and the
// documents around them are kept.
func TestRenderRedactsEveryDuplicateAliasAndMergeShape(t *testing.T) {
	t.Parallel()
	secret := "kind: Secret\nmetadata:\n  name: shop-creds\n"
	for _, tc := range []struct {
		name  string
		input string
		keeps []string
	}{
		{
			name:  "a duplicate stringData key",
			input: secret + "stringData:\n  a: harmless\nstringData:\n  password: " + treeScopeDesiredValue + "\n",
			keeps: []string{"name: shop-creds"},
		},
		{
			name:  "a null stringData before the real one",
			input: secret + "stringData:\nstringData:\n  password: " + treeScopeDesiredValue + "\n",
			keeps: []string{"name: shop-creds"},
		},
		{
			name:  "a duplicate data key that holds the value last",
			input: secret + "data:\n  password: " + b64("harmless") + "\ndata:\n  password: " + b64(treeScopeDesiredValue) + "\n",
			keeps: []string{"name: shop-creds"},
		},
		{
			name:  "an anchor in an annotation, aliased by stringData",
			input: secret + "  annotations:\n    note: &pw " + treeScopeDesiredValue + "\nstringData:\n  password: *pw\n",
			keeps: []string{"name: shop-creds"},
		},
		{
			name:  "an anchor in a label, aliased by stringData",
			input: secret + "  labels:\n    l: &pw " + treeScopeDesiredValue + "\nstringData:\n  password: *pw\n",
			keeps: []string{"name: shop-creds"},
		},
		{
			name:  "an alias in an annotation that points into stringData",
			input: "kind: Secret\nstringData:\n  password: &pw " + treeScopeDesiredValue + "\nmetadata:\n  name: shop-creds\n  annotations:\n    copy: *pw\n",
			keeps: []string{"name: shop-creds"},
		},
		{
			name:  "an anchor on the document root",
			input: "&root\nkind: Secret\nmetadata:\n  name: shop-creds\nstringData:\n  password: " + treeScopeDesiredValue + "\n",
			keeps: []string{"name: shop-creds"},
		},
		{
			name:  "a merge key that copies the value into stringData",
			input: secret + "base: &base\n  password: " + treeScopeDesiredValue + "\nstringData:\n  <<: *base\n",
			keeps: []string{"name: shop-creds"},
		},
		{
			name: "an anchor on a List root",
			input: "&l\nkind: List\nitems:\n- kind: Secret\n  metadata:\n    name: shop-creds\n  stringData:\n    password: " +
				treeScopeDesiredValue + "\n- kind: ConfigMap\n  metadata:\n    name: cfg\n",
			keeps: []string{"name: cfg"},
		},
		{
			name: "a List with a duplicate items key",
			input: "kind: List\nitems:\n- kind: Secret\n  metadata:\n    name: shop-creds\n  stringData:\n    password: " +
				treeScopeDesiredValue + "\nitems:\n- kind: ConfigMap\n  metadata:\n    name: cfg\n",
			keeps: []string{"name: cfg"},
		},
		{
			name:  "a ConfigMap whose kind is overridden by a later Secret kind",
			input: "kind: ConfigMap\nmetadata:\n  name: cfg\nkind: Secret\nstringData:\n  password: " + treeScopeDesiredValue + "\n",
			keeps: []string{"name: cfg"},
		},
		{
			name:  "a Secret with a comment above a value",
			input: secret + "stringData:\n  # default: " + treeScopeDesiredValue + "\n  password: " + treeScopeDesiredValue + "\n",
			keeps: []string{"name: shop-creds", "password: <redacted>"},
		},
		{
			name:  "a Secret with a trailing comment that holds a value",
			input: secret + "stringData:\n  password: " + treeScopeDesiredValue + "\n  # trailing " + treeScopeDesiredValue + "\n",
			keeps: []string{"name: shop-creds", "password: <redacted>"},
		},
		{
			name:  "a Secret with a comment on an annotation that holds a value",
			input: secret + "  annotations:\n    # copied " + treeScopeDesiredValue + "\n    owner: team-a\nstringData:\n  password: " + treeScopeDesiredValue + "\n",
			keeps: []string{"name: shop-creds", "owner: team-a", "password: <redacted>"},
		},
		{
			name: "a last-applied annotation that holds the values",
			input: secret + "  annotations:\n    " + lastAppliedConfigAnnotation + ": " +
				fmt.Sprintf("%q", `{"stringData":{"password":"`+treeScopeDesiredValue+`"}}`) + "\nstringData:\n  password: " + treeScopeDesiredValue + "\n",
			keeps: []string{"name: shop-creds", "password: <redacted>"},
		},
		{
			name: "a kapp original annotation that holds the values",
			input: secret + "  annotations:\n    " + kappOriginalAnnotation + ": " +
				fmt.Sprintf("%q", `{"stringData":{"password":"`+treeScopeDesiredValue+`"}}`) + "\nstringData:\n  password: " + treeScopeDesiredValue + "\n",
			keeps: []string{"name: shop-creds"},
		},
	} {
		out, err := renderThroughServer(t, tc.input)
		require.NoError(t, err, tc.name)
		assertNoSecretValues(t, out)
		for _, want := range tc.keeps {
			require.Contains(t, out, want, tc.name)
		}
	}
}

// A Secret's own identity fields are kept even when a value matches them: a value
// that is the same text as the namespace or the name does not hide either.
func TestRenderKeepsIdentityFieldsOfASecretWhoseValueMatchesThem(t *testing.T) {
	t.Parallel()
	// token holds the API version's text, so the identity fields are checked against a value that matches them too.
	rendered := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: shop\n  namespace: shop\n  labels:\n    shop-team: red\nstringData:\n  password: shop\n  token: v1\n"
	out, err := renderThroughServer(t, rendered)
	require.NoError(t, err)
	require.Contains(t, out, "apiVersion: v1")
	require.Contains(t, out, "kind: Secret")
	require.Contains(t, out, "name: shop")
	require.Contains(t, out, "namespace: shop")
	require.Contains(t, out, "shop-team: red", "a key is never replaced")
	require.Contains(t, out, "password: <redacted>")
}

// The identity fields of a managed Secret are kept in the redacted manifest, and a
// value that equals a key or a name does not change them.
func TestGetResourceKeepsIdentityOfASecretWhoseValueMatchesIt(t *testing.T) {
	t.Parallel()
	desired := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: shop-creds\n  namespace: shop\nstringData:\n  password: " + logsScopeNamespace + "\n"
	srv, _ := treeScopeServer(t, treeScopeApplication(), treeScopeDestination(),
		WithRenderer(&fakeRenderer{manifests: []byte(desired)}))

	resp, err := srv.GetResource(context.Background(), getResourceReq("Secret", "shop-creds", logsScopeNamespace))
	require.NoError(t, err)
	require.Contains(t, resp.Msg.DesiredManifest, "name: shop-creds")
	require.Contains(t, resp.Msg.DesiredManifest, "namespace: shop")
	require.Contains(t, resp.Msg.DesiredManifest, "kind: Secret")
	require.Contains(t, resp.Msg.DesiredManifest, desiredDiffersValue)
	assertNoSecretValues(t, resp.Msg.String())
}

// A rotated value kapp kept in its original annotation is replaced whole, as the
// last-applied annotation is, even when no current value matches it.
func TestGetResourceReplacesAKappOriginalThatHoldsARotatedValue(t *testing.T) {
	t.Parallel()
	original := `{"kind":"Secret","stringData":{"password":"` + treeScopeRotatedValue + `"}}`
	destination := shopCredsDestination(
		map[string][]byte{"password": []byte(treeScopeLiveValue)},
		map[string]string{kappOriginalAnnotation: original, "owner": "team-a"})
	srv, _ := treeScopeServer(t, treeScopeApplication(), destination)

	resp, err := srv.GetResource(context.Background(), getResourceReq("Secret", "shop-creds", logsScopeNamespace))
	require.NoError(t, err)
	require.Equal(t, redactedSecretValue, resp.Msg.Annotations[kappOriginalAnnotation])
	require.Equal(t, "team-a", resp.Msg.Annotations["owner"])
	assertNoSecretValues(t, resp.Msg.String())
}

// A Secret whose value changed, and whose shape is the same on both sides, still
// gives a diff: the changed key shows its marker on each side.
func TestGetResourceShowsAValueOnlyChangeToASecret(t *testing.T) {
	t.Parallel()
	desired := `apiVersion: v1
kind: Secret
metadata:
  name: shop-creds
  namespace: shop
  labels:
    app.paprika.io/name: shop-app
    app.paprika.io/managed-by: paprika
data:
  password: ` + b64(treeScopeDesiredValue) + `
`
	destination := shopCredsDestination(map[string][]byte{"password": []byte(treeScopeLiveValue)}, nil)
	srv, _ := treeScopeServer(t, treeScopeApplication(), destination,
		WithRenderer(&fakeRenderer{manifests: []byte(desired)}))

	resp, err := srv.GetResource(context.Background(), getResourceReq("Secret", "shop-creds", logsScopeNamespace))
	require.NoError(t, err)
	require.NotEmpty(t, resp.Msg.Diff)
	requireChangedPair(t, resp.Msg.Diff, "password")
	assertNoSecretValues(t, resp.Msg.String())
}

// A value change is shown even when the live object carries labels the desired
// object does not, which adds lines to the diff of its own.
func TestGetResourceShowsAValueChangeAmongInjectedLabels(t *testing.T) {
	t.Parallel()
	desired := `apiVersion: v1
kind: Secret
metadata:
  name: shop-creds
  namespace: shop
data:
  k1: ` + b64("v1") + `
  k2: ` + b64("v2") + `
  k3: ` + b64(treeScopeDesiredValue) + `
  k4: ` + b64("v4") + `
  k5: ` + b64("v5") + `
  k6: ` + b64("v6") + `
`
	live := map[string][]byte{"k1": []byte("v1"), "k2": []byte("v2"), "k3": []byte(treeScopeLiveValue),
		"k4": []byte("v4"), "k5": []byte("v5"), "k6": []byte("v6")}
	srv, _ := treeScopeServer(t, treeScopeApplication(), shopCredsDestination(live, nil),
		WithRenderer(&fakeRenderer{manifests: []byte(desired)}))

	resp, err := srv.GetResource(context.Background(), getResourceReq("Secret", "shop-creds", logsScopeNamespace))
	require.NoError(t, err)
	requireChangedPair(t, resp.Msg.Diff, "k3")
	assertNoSecretValues(t, resp.Msg.String())
}

// Investigate's config-drift finding fires for a value-only change, and its diff
// carries the changed key as a marked pair with no value.
func TestInvestigateShowsAValueOnlyChangeToASecret(t *testing.T) {
	t.Parallel()
	desired := `apiVersion: v1
kind: Secret
metadata:
  name: shop-creds
  namespace: shop
data:
  password: ` + b64(treeScopeDesiredValue) + `
`
	destination := shopCredsDestination(map[string][]byte{"password": []byte(treeScopeLiveValue)}, nil)
	srv, _ := treeScopeServer(t, treeScopeApplication(), destination,
		WithRenderer(&fakeRenderer{manifests: []byte(desired)}))

	resp, err := srv.Investigate(context.Background(), connect.NewRequest(&paprikav1.InvestigateRequest{
		ApplicationNamespace: "platform",
		ApplicationName:      "shop-app",
		ResourceKind:         "Secret",
		ResourceName:         "shop-creds",
		ResourceNamespace:    logsScopeNamespace,
	}))
	require.NoError(t, err)
	require.Contains(t, resp.Msg.String(), "config_drift_shop-creds", "a value-only change fires config drift")
	require.Contains(t, resp.Msg.String(), desiredDiffersValue)
	require.Contains(t, resp.Msg.String(), liveDiffersValue)
	assertNoSecretValues(t, resp.Msg.String())
}

// The MCP investigate tool shows the same marked pair for a value-only change.
func TestInvestigateShowsAValueOnlyChangeToASecretOverMCP(t *testing.T) {
	t.Parallel()
	desired := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: shop-creds\n  namespace: shop\ndata:\n  password: " + b64(treeScopeDesiredValue) + "\n"
	destination := shopCredsDestination(map[string][]byte{"password": []byte(treeScopeLiveValue)}, nil)
	srv, _ := treeScopeServer(t, treeScopeApplication(), destination,
		WithRenderer(&fakeRenderer{manifests: []byte(desired)}))
	client := treeScopeClient(t, srv)
	registry := mcp.NewRegistry()
	require.NoError(t, mcp.RegisterReadTools(registry))

	investigate, ok := registry.Lookup("investigate")
	require.True(t, ok)
	out, err := investigate.Invoke(context.Background(), client, json.RawMessage(`{
		"application_namespace":"platform","application_name":"shop-app",
		"resource_kind":"Secret","resource_name":"shop-creds","resource_namespace":"shop"}`))
	require.NoError(t, err)
	encoded, err := json.Marshal(out)
	require.NoError(t, err)
	require.Contains(t, string(encoded), "config_drift_shop-creds")
	// encoding/json escapes the angle brackets of a marker, so the text is checked without them.
	require.Contains(t, string(encoded), "redacted: desired value differs")
	require.Contains(t, string(encoded), "redacted: live value differs")
	assertNoSecretValues(t, string(encoded))
}

// Every position a comment can take on a plain Secret, and on a List, is checked.
// A comment that holds the value is dropped, wherever it sits: on the document, on
// the root or metadata keys, on the identity fields, and on the data keys.
func TestRenderDropsEveryCommentThatHoldsAValue(t *testing.T) {
	t.Parallel()
	v := treeScopeDesiredValue
	secret := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: shop-creds\nstringData:\n  password: " + v + "\n"
	for _, tc := range []struct {
		name  string
		input string
	}{
		{"a head comment above the document", "# value: " + v + "\n" + secret},
		{"a head comment after a blank line", "# value: " + v + "\n\n" + secret},
		{"a head comment after a separator", "---\n# value: " + v + "\n" + secret},
		{"a foot comment after stringData", secret + "# foot " + v + "\n"},
		{"a line comment on apiVersion", strings.Replace(secret, "apiVersion: v1", "apiVersion: v1 # "+v, 1)},
		{"a head comment on apiVersion", strings.Replace(secret, "apiVersion: v1", "# "+v+"\napiVersion: v1", 1)},
		{"a line comment on kind", strings.Replace(secret, "kind: Secret", "kind: Secret # "+v, 1)},
		{"a line comment on metadata", strings.Replace(secret, "metadata:", "metadata: # "+v, 1)},
		{"a head comment on metadata", strings.Replace(secret, "metadata:", "# "+v+"\nmetadata:", 1)},
		{"a line comment on metadata.name", strings.Replace(secret, "name: shop-creds", "name: shop-creds # "+v, 1)},
		{"a head comment on stringData", strings.Replace(secret, "stringData:", "# "+v+"\nstringData:", 1)},
		{"a line comment on stringData", strings.Replace(secret, "stringData:", "stringData: # "+v, 1)},
		{"a head comment on a data key", strings.Replace(secret, "  password:", "  # "+v+"\n  password:", 1)},
		{"a line comment on a data key", strings.Replace(secret, "  password:", "  password: # "+v+"\n  p2:", 1)},
		{"a comment on a List", "kind: List # " + v + "\nitems:\n- kind: Secret\n  metadata:\n    name: shop-creds\n  stringData:\n    password: " + v + "\n"},
		{"a comment on the items key", "kind: List\nitems: # " + v + "\n- kind: Secret\n  metadata:\n    name: shop-creds\n  stringData:\n    password: " + v + "\n"},
		{"a comment on a List item", "kind: List\nitems:\n- # " + v + "\n  kind: Secret\n  metadata:\n    name: shop-creds\n  stringData:\n    password: " + v + "\n"},
	} {
		out, err := renderThroughServer(t, tc.input)
		require.NoError(t, err, tc.name)
		require.NotContains(t, out, v, tc.name)
		require.NotContains(t, out, b64(v), tc.name)
		require.Contains(t, out, "<redacted>", tc.name)
	}
}

// A comment that holds no value is kept, so only the comments with a value go.
func TestRenderKeepsACommentThatHoldsNoValue(t *testing.T) {
	t.Parallel()
	rendered := "# managed secret\napiVersion: v1\nkind: Secret\nmetadata:\n  name: shop-creds # owned by the platform\nstringData:\n  password: " + treeScopeDesiredValue + "\n"
	out, err := renderThroughServer(t, rendered)
	require.NoError(t, err)
	require.Contains(t, out, "# managed secret")
	require.Contains(t, out, "# owned by the platform")
	assertNoSecretValues(t, out)
}

// The values of a List's own fields and its items are kept out of each other, and
// out of the List's annotations.
func TestRenderRedactsAListsOwnFieldsCopyingAnItemValue(t *testing.T) {
	t.Parallel()
	items := "items:\n- kind: Secret\n  metadata:\n    name: shop-creds\n  stringData:\n    password: " + treeScopeDesiredValue + "\n"
	for _, tc := range []struct {
		name  string
		input string
	}{
		{"a List annotation copies the value", "kind: List\nmetadata:\n  annotations:\n    copied: " + treeScopeDesiredValue + "\n" + items},
		{"a List label copies the value through a duplicate key", "kind: List\nmetadata:\n  labels:\n    a: x\n  labels:\n    copied: " + treeScopeDesiredValue + "\n" + items},
		{"a List of Secrets with another top-level field copying the value", "kind: SecretList\nspec:\n  note: " + treeScopeDesiredValue + "\n" + items},
		{"a Bundle with an items list that holds a Secret", "kind: Bundle\nmetadata:\n  name: bundle\n" + items},
		{"a Bundle with a duplicate key, read as a decoded object", "kind: Bundle\nmetadata:\n  name: bundle\nmetadata:\n  name: bundle\n" + items},
	} {
		out, err := renderThroughServer(t, tc.input)
		require.NoError(t, err, tc.name)
		assertNoSecretValues(t, out)
		require.Contains(t, out, "<redacted>", tc.name)
	}
}

// A Secret whose key is written with a BOM, or with an explicit tag, is read by the
// controller as a Secret. The values of such a document are redacted too.
func TestRedactSecretManifestsReadsAsTheControllerDoes(t *testing.T) {
	t.Parallel()
	v := treeScopeDesiredValue
	for _, tc := range []struct {
		name  string
		input string
	}{
		{"a later document starts with a BOM before its kind",
			"kind: ConfigMap\nmetadata:\n  name: cfg\n---\n\ufeffkind: Secret\nmetadata:\n  name: shop-creds\nstringData:\n  password: " + v + "\n"},
		{"a document that starts with a BOM before its kind and stringData",
			"\ufeffkind: Secret\nmetadata:\n  name: shop-creds\nstringData:\n  password: " + v + "\n"},
		{"a binary-tagged data key holding a double-encoded value",
			"kind: Secret\nmetadata:\n  name: shop-creds\ndata:\n  !!binary ZGF0YQ==: !!binary " + b64(b64(v)) + "\n"},
	} {
		out, err := redactSecretManifests([]byte(tc.input))
		require.NoError(t, err, tc.name)
		require.NotContains(t, string(out), v, tc.name)
		require.NotContains(t, string(out), b64(v), tc.name)
		require.Contains(t, string(out), "name: shop-creds", tc.name)
	}
}

// A top-level sequence is redacted as a List of Secret items, and a top-level
// scalar, which the controller cannot apply, is kept as it is.
func TestRedactSecretManifestsRedactsASequenceAndKeepsAScalar(t *testing.T) {
	t.Parallel()
	out, err := redactSecretManifests([]byte("- kind: Secret\n  metadata:\n    name: shop-creds\n  stringData:\n    password: " + treeScopeDesiredValue + "\n"))
	require.NoError(t, err)
	assertNoSecretValues(t, string(out))
	require.Contains(t, string(out), "password: <redacted>")

	out, err = redactSecretManifests([]byte("just text\n"))
	require.NoError(t, err)
	require.Equal(t, "just text\n", string(out))
}

// A Secret whose key the controller cannot read fails the render, and the error
// does not quote the document.
func TestRedactSecretManifestsFailsClosedOnAKeyTheControllerCannotRead(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name  string
		input string
	}{
		{"a complex key", "kind: Secret\nmetadata:\n  name: shop-creds\nstringData:\n  ? [a]\n  : " + treeScopeDesiredValue + "\n"},
		{"a merge key with a scalar", "kind: Secret\nmetadata:\n  name: shop-creds\nstringData:\n  <<: 1\n  password: " + treeScopeDesiredValue + "\n"},
	} {
		out, err := redactSecretManifests([]byte(tc.input))
		require.Error(t, err, tc.name)
		require.Nil(t, out, tc.name)
		require.NotContains(t, err.Error(), treeScopeDesiredValue, tc.name)
	}
}

// A comment-only document holds no content, so nothing of it is written.
func TestRedactSecretManifestsDropsACommentOnlyDocument(t *testing.T) {
	t.Parallel()
	out, err := redactSecretManifests([]byte("# " + treeScopeDesiredValue + "\n"))
	require.NoError(t, err)
	require.NotContains(t, string(out), treeScopeDesiredValue)
}

// A value copied elsewhere in the object is caught in its trimmed text and in each
// common base64 encoding of it, padded or not, standard or URL-safe.
func TestRedactSecretValuesCatchesTrimmedAndEncodedCopies(t *testing.T) {
	t.Parallel()
	const value = "shared-secret-value"
	trimmed := value
	for _, copied := range []string{
		trimmed,
		base64.StdEncoding.EncodeToString([]byte(trimmed)),
		base64.RawStdEncoding.EncodeToString([]byte(trimmed)),
		base64.URLEncoding.EncodeToString([]byte(trimmed)),
		base64.RawURLEncoding.EncodeToString([]byte(trimmed)),
	} {
		secret := map[string]any{
			"kind": "Secret",
			"metadata": map[string]any{
				"name":        "creds",
				"annotations": map[string]any{"copied": copied, "keep": "me"},
			},
			"stringData": map[string]any{"password": value + "\n"},
		}
		redactSecretValues(secret)
		meta, ok := secret["metadata"].(map[string]any)
		require.True(t, ok)
		annotations, ok := meta["annotations"].(map[string]any)
		require.True(t, ok)
		require.Equal(t, redactedSecretValue, annotations["copied"], "copy %q", copied)
		require.Equal(t, "me", annotations["keep"])
	}
}

// A document the controller cannot decode, and that is not a Secret or a List, is
// kept as written. Only a Secret or a List that cannot be decoded fails the render.
func TestRedactSecretManifestsKeepsAnUndecodableDocumentThatIsNotASecret(t *testing.T) {
	t.Parallel()
	out, err := redactSecretManifests([]byte("kind: ConfigMap\nmetadata:\n  name: cfg\ndata:\n  ? [a]\n  : one\n"))
	require.NoError(t, err)
	require.Contains(t, string(out), "name: cfg")
}
