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
	"gopkg.in/yaml.v3"
	"k8s.io/apimachinery/pkg/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	k8syaml "sigs.k8s.io/yaml"

	"github.com/benebsworth/paprika/internal/api/mcp"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/engine"
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

// requireDocumentRefused fails unless err is the refusal for the document at index.
// The message must not hold any of the values or their base64.
func requireDocumentRefused(t *testing.T, err error, index int, values ...string) {
	t.Helper()
	require.Error(t, err)
	require.EqualError(t, err, fmt.Sprintf("rendered document %d could not be checked for Secret values", index))
	for _, v := range values {
		require.NotContains(t, err.Error(), v)
		require.NotContains(t, err.Error(), b64(v))
	}
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

// A top-level sequence that holds a sequence fails the render, and the error names only
// the position of the document. A sequence of mappings and scalars is still redacted.
func TestRedactSecretManifestsRefusesASequenceThatHoldsASequence(t *testing.T) {
	t.Parallel()
	v := treeScopeDesiredValue
	_, err := redactSecretManifests([]byte("- - kind: Secret\n    stringData: {password: " + v + "}\n"))
	requireDocumentRefused(t, err, 1, v)

	_, err = redactSecretManifests([]byte("kind: ConfigMap\nmetadata: {name: cfg}\n---\n- - kind: Secret\n    stringData: {password: " + v + "}\n"))
	requireDocumentRefused(t, err, 2, v)

	out, err := redactSecretManifests([]byte("- kind: Secret\n  metadata: {name: shop-creds}\n  stringData: {password: " + v + "}\n- plain scalar\n"))
	require.NoError(t, err)
	assertNoSecretValues(t, string(out))
	require.Contains(t, string(out), "plain scalar")
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
		require.Nil(t, out, tc.name)
		require.Error(t, err, tc.name)
		require.NotContains(t, err.Error(), treeScopeDesiredValue, tc.name)
		require.NotContains(t, err.Error(), b64(treeScopeDesiredValue), tc.name)
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

// A scalar outside data and stringData is scanned for a value only up to the scan
// cap. A longer scalar is replaced without a scan, and a shorter one is matched as
// before.
func TestRenderReplacesAStrayScalarOverTheScanCap(t *testing.T) {
	t.Parallel()
	over := strings.Repeat("x", secretScanCap+1)
	under := strings.Repeat("y", secretScanCap)
	rendered := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: shop-creds\n  annotations:\n" +
		"    over: " + over + "\n" +
		"    under: " + under + "\n" +
		"    copied: note " + treeScopeDesiredValue + "\n" +
		"stringData:\n  password: " + treeScopeDesiredValue + "\n"
	out, err := renderThroughServer(t, rendered)
	require.NoError(t, err)
	// The long texts are checked with strings.Contains, so a failure does not print them.
	require.False(t, strings.Contains(out, over), "a scalar over the scan cap was kept")
	require.True(t, strings.Contains(out, "under: "+under), "a scalar under the scan cap was replaced")
	require.Contains(t, out, "over: <redacted>")
	require.Contains(t, out, "copied: <redacted>")
	assertNoSecretValues(t, out)
}

// A value shorter than secretFormMinLen is not searched for outside data and
// stringData, so ordinary labels and annotations that contain its characters keep
// their text. Each data and stringData value is still replaced.
func TestRenderKeepsOrdinaryTextThatHoldsAShortSecretValue(t *testing.T) {
	t.Parallel()
	rendered := "apiVersion: v1\nkind: Secret\nmetadata:\n" +
		"  name: shop-creds\n" +
		"  labels:\n    app.kubernetes.io/version: 1.4.0\n    tier: backend\n" +
		"  annotations:\n    description: Edge credentials, rotated 1 day ago\n" +
		"data:\n  digit: MQ==\n  letter: ZQ==\n" +
		"stringData:\n  pin: \"1\"\n  initial: e\n"
	out, err := renderThroughServer(t, rendered)
	require.NoError(t, err)
	require.Contains(t, out, "app.kubernetes.io/version: 1.4.0")
	require.Contains(t, out, "tier: backend")
	require.Contains(t, out, "description: Edge credentials, rotated 1 day ago")
	require.Contains(t, out, "digit: <redacted>")
	require.Contains(t, out, "letter: <redacted>")
	require.Contains(t, out, "pin: <redacted>")
	require.Contains(t, out, "initial: <redacted>")
}

// A value of secretFormMinLen bytes or more still finds its copies outside data and
// stringData.
func TestRenderReplacesAnAnnotationThatHoldsAMinimumLengthValue(t *testing.T) {
	t.Parallel()
	const value = "abcdef"
	rendered := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: shop-creds\n  annotations:\n    copied: " + value + "\n" +
		"stringData:\n  password: " + value + "\n"
	out, err := renderThroughServer(t, rendered)
	require.NoError(t, err)
	require.NotContains(t, out, value)
	require.Contains(t, out, "copied: <redacted>")
}

// Two inputs that yaml.v3 cannot read are refused. The controller may apply such
// text, but Render refuses text it cannot check.
func TestRedactSecretManifestsRefusesADocumentThatYAMLCannotRead(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name  string
		input string
		index int
	}{
		{"a flow mapping followed by a stray quoted scalar",
			"{kind: ConfigMap, metname: cfg},\"0000000000000000", 1},
		{"a second document after a separator with a space is malformed",
			"kind: ConfigMap\nmetadata:\n  name: cfg\n--- \nkind: ConfigMap\ndata: {a: \"unterminated\n", 2},
	} {
		chunk := engine.SplitYAMLDocuments([]byte(tc.input))
		require.Len(t, chunk, 1, tc.name)
		view, err := decodeManifest(chunk[0])
		require.NoError(t, err, tc.name)
		require.Equal(t, "ConfigMap", kindOf(view), tc.name)

		out, err := redactSecretManifests([]byte(tc.input))
		require.Nil(t, out, tc.name)
		requireDocumentRefused(t, err, tc.index)
	}
}

// A malformed document fails the render, even when a readable Secret follows it in
// the stream. The Secret is not returned, and the error names the malformed document.
func TestRedactSecretManifestsRefusesAMalformedDocumentBeforeAReadableSecret(t *testing.T) {
	t.Parallel()
	input := "kind: ConfigMap\nmetadata:\n  name: cfg\n--- \nkind: [\n--- \nkind: Secret\nmetadata:\n  name: shop-creds\nstringData:\n  password: " + treeScopeDesiredValue + "\n"
	out, err := redactSecretManifests([]byte(input))
	require.Nil(t, out)
	requireDocumentRefused(t, err, 2, treeScopeDesiredValue)
}

// A malformed Secret, or a malformed List, fails the render, whether it is the first
// document of the stream or a later one. The error names the document's position,
// and not its kind or its values.
func TestRedactSecretManifestsFailsOnAnUnreadableSecretOrList(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name  string
		input string
		index int
	}{
		{"an unreadable Secret in the first position",
			"kind: Secret\nmetadata:\n  name: shop-creds\nstringData: {password: " + treeScopeDesiredValue + "\n", 1},
		{"an unreadable Secret after a separator with a space",
			"kind: ConfigMap\nmetadata:\n  name: cfg\n--- \nkind: Secret\nmetadata:\n  name: shop-creds\nstringData: {password: " + treeScopeDesiredValue + "\n", 2},
		{"an unreadable List after a separator",
			"kind: ConfigMap\nmetadata:\n  name: cfg\n---\nkind: SecretList\nitems: [" + treeScopeDesiredValue + "\n", 2},
		{"an anchored Secret in the first position that the controller reads as a Secret",
			"{kind: &k Secret, metadata: {name: s}, stringData: {password: " + treeScopeDesiredValue + "}},\"0000000000000000", 1},
		{"an anchored Secret after a separator with a space",
			"kind: ConfigMap\nmetadata:\n  name: cfg\n--- \nkind: &k Secret\nstringData: {password: " + treeScopeDesiredValue + "\n", 2},
		{"a binary-tagged Secret kind in the first position",
			"kind: !!binary U2VjcmV0\nmetadata:\n  name: shop-creds\nstringData: {password: " + treeScopeDesiredValue + "\n", 1},
		{"an escaped kind after a separator with a space",
			"kind: ConfigMap\nmetadata:\n  name: cfg\n--- \nkind: \"Secr\\x65t\"\nstringData: {password: " + treeScopeDesiredValue + "\n", 2},
		{"a folded block kind after a separator with a space",
			"kind: ConfigMap\nmetadata:\n  name: cfg\n--- \nkind: >-\n  Secret\nstringData: {password: " + treeScopeDesiredValue + "\n", 2},
		{"a Secret kind after a comment line, after a separator with a space",
			"kind: ConfigMap\nmetadata:\n  name: cfg\n--- \n# note\nkind: Secret\nstringData: {password: " + treeScopeDesiredValue + "\n", 2},
	} {
		out, err := redactSecretManifests([]byte(tc.input))
		require.Nil(t, out, tc.name)
		requireDocumentRefused(t, err, tc.index, treeScopeDesiredValue)
	}
}

// A document-end marker, "...", inside a Secret fails the render. The controller reads
// the Secret from the text before the marker, and the text after it as a document of
// its own. Render refuses the Secret, so neither the values nor their text is returned.
func TestRedactSecretManifestsRefusesASecretWithADocumentEndMarker(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name  string
		input string
		index int
	}{
		{"a document-end marker before stringData",
			"kind: Secret\nmetadata:\n  name: shop-creds\n...\nstringData:\n  password: " + treeScopeDesiredValue + "\n", 2},
		{"a document-end marker followed by text before stringData",
			"kind: Secret\nmetadata:\n  name: shop-creds\n... x\nstringData:\n  password: " + treeScopeDesiredValue + "\n", 1},
	} {
		out, err := redactSecretManifests([]byte(tc.input))
		require.Nil(t, out, tc.name)
		requireDocumentRefused(t, err, tc.index, treeScopeDesiredValue)
	}
}

// An items list that cannot be checked fails the render, whether its items are read as
// Secrets or the Secret is anchored or merged. The error names the document's position
// and not its values, and no value or its base64 reaches the output.
func TestRedactSecretManifestsRefusesAnItemsListThatCannotBeChecked(t *testing.T) {
	t.Parallel()
	v := treeScopeDesiredValue
	head := "kind: ConfigMap\nmetadata:\n  name: cfg\n--- \n"
	for _, tc := range []struct {
		name  string
		input string
		index int
	}{
		{"an items list with an anchored Secret and a merge key",
			"{items: [{kind: Secret, metadata: {name: s}, stringData: &s {kind: " + v + "}}], <<: *s},\"0000000000000000", 1},
		{"the same items list after a separator with a space",
			head + "{items: [{kind: Secret, metadata: {name: s}, stringData: &s {kind: " + v + "}}], <<: *s},\"0000000000000000", 2},
		{"a block Secret with an anchored stringData and a merge key, then a malformed value",
			"items:\n- kind: Secret\n  metadata: {name: s}\n  stringData: &s\n    kind: " + v + "\n    <<: *s\n    bad: [\n", 1},
		{"a Bundle with an undecodable item that holds a Secret value",
			"kind: Bundle\nitems:\n- stringData:\n    password: " + v + "\n  ? [a]\n  : b\n", 1},
		{"an items list with a complex key under a Secret item",
			"items:\n- stringData:\n    password: " + v + "\n  ? [a]\n  : b\n", 1},
	} {
		out, err := redactSecretManifests([]byte(tc.input))
		require.Nil(t, out, tc.name)
		requireDocumentRefused(t, err, tc.index, v)
	}
}

// A render that cannot check a document returns CodeInvalidArgument, and its message
// names the document and not its values.
func TestRenderReturnsInvalidArgumentForAnUnreadableSecret(t *testing.T) {
	t.Parallel()
	_, err := renderThroughServer(t, "kind: Secret\nmetadata:\n  name: shop-creds\nstringData: {password: "+treeScopeDesiredValue+"\n")
	require.Error(t, err)
	var connectErr *connect.Error
	require.ErrorAs(t, err, &connectErr)
	require.Equal(t, connect.CodeInvalidArgument, connectErr.Code())
	require.Equal(t, "rendered document 1 could not be checked for Secret values", connectErr.Message())
	require.NotContains(t, connectErr.Message(), treeScopeDesiredValue)
}

// The last-applied and kapp original annotations of a Secret are replaced whole, even
// when they hold a value that stringData no longer has, a rotated value. The stray
// check cannot find such a value, so only the whole replacement removes it. Both
// the rendered node and the decoded object are checked.
func TestRedactionReplacesAppliedCopiesThatHoldARotatedValue(t *testing.T) {
	t.Parallel()
	const rotated = treeScopeRotatedValue
	rendered := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: shop-creds\n  annotations:\n" +
		"    kubectl.kubernetes.io/last-applied-configuration: '{\"kind\":\"Secret\",\"stringData\":{\"password\":\"" + rotated + "\"}}'\n" +
		"    kapp.k14s.io/original: 'password: " + rotated + "'\n" +
		"    owner: platform\n" +
		"stringData:\n  password: " + treeScopeDesiredValue + "\n"
	out, err := renderThroughServer(t, rendered)
	require.NoError(t, err)
	require.False(t, strings.Contains(out, rotated), "the rotated value was kept")
	require.Contains(t, out, "kubectl.kubernetes.io/last-applied-configuration: <redacted>")
	require.Contains(t, out, "kapp.k14s.io/original: <redacted>")
	require.Contains(t, out, "owner: platform")
	assertNoSecretValues(t, out)

	secret := map[string]any{
		"apiVersion": "v1",
		"kind":       "Secret",
		"metadata": map[string]any{
			"name": "shop-creds",
			"annotations": map[string]any{
				lastAppliedConfigAnnotation: `{"stringData":{"password":"` + rotated + `"}}`,
				kappOriginalAnnotation:      "password: " + rotated,
				"owner":                     "platform",
			},
		},
		"stringData": map[string]any{"password": treeScopeDesiredValue},
	}
	redactSecretValues(secret)
	meta, ok := secret["metadata"].(map[string]any)
	require.True(t, ok)
	annotations, ok := meta["annotations"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, redactedSecretValue, annotations[lastAppliedConfigAnnotation])
	require.Equal(t, redactedSecretValue, annotations[kappOriginalAnnotation])
	require.Equal(t, "platform", annotations["owner"])
}

// A Secret that uses an alias is redacted as a decoded object, so the output still
// reads back as YAML. Redacting its node in place would leave the alias without its
// anchor.
func TestRenderRedactsASecretWithAnAliasSoItReadsBack(t *testing.T) {
	t.Parallel()
	rendered := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: shop-creds\n  annotations:\n" +
		"    note: &v " + treeScopeDesiredValue + "\n    copy: *v\n" +
		"stringData:\n  password: " + treeScopeDesiredValue + "\n  other: *v\n"
	out, err := renderThroughServer(t, rendered)
	require.NoError(t, err)
	assertNoSecretValues(t, out)
	var obj map[string]any
	require.NoError(t, k8syaml.Unmarshal([]byte(out), &obj), "the rendered Secret does not read back")
	require.Equal(t, "Secret", obj["kind"])
}

// A document that yaml.v3 reads, followed by one it cannot read, fails the render.
// Each separator is a line break that yaml.v3 reads as one before the separator.
func TestRedactSecretManifestsFailsOnAnUnreadableDocumentAfterAReadableOne(t *testing.T) {
	t.Parallel()
	for _, sep := range []string{"\u2028", "\u2029", "\u0085", "\r"} {
		input := "kind: &k Secret\nmetadata:\n  name: s\nstringData:\n  password: " + treeScopeDesiredValue + sep + "---" + sep + "bad: ["
		out, err := redactSecretManifests([]byte(input))
		require.Error(t, err, "separator %U", []rune(sep)[0])
		require.Nil(t, out)
		require.NotContains(t, err.Error(), treeScopeDesiredValue)
		require.Equal(t, "rendered document 2 could not be checked for Secret values", err.Error())
	}
}

// An unreadable first document that the controller reads as a Secret, or cannot
// decode at all, fails the render when its text is not readable. Its value is not
// returned.
func TestRedactSecretManifestsFailsOnAFirstDocumentTheControllerCannotRead(t *testing.T) {
	t.Parallel()
	for _, input := range []string{
		"kind: &k Secret\nmetadata:\n  name: s\nstringData:\n  password: " + treeScopeDesiredValue + "\nbad: [\n",
		"kind: ConfigMap\nmetadata:\n  name: [cfg\n",
	} {
		out, err := redactSecretManifests([]byte(input))
		require.Nil(t, out)
		requireDocumentRefused(t, err, 1, treeScopeDesiredValue)
	}
}

// The error names only the document's position. A value placed under a stringData key
// named kind is not named.
func TestRenderErrorDoesNotQuoteAValueUnderAKindKey(t *testing.T) {
	t.Parallel()
	const value = "Hunter2TokenValue99"
	rendered := "stringData:\n  kind: " + value + "\nkind: Secret\nmetadata: {name: [\n"
	_, err := renderThroughServer(t, rendered)
	require.Error(t, err)
	var connectErr *connect.Error
	require.ErrorAs(t, err, &connectErr)
	require.Equal(t, connect.CodeInvalidArgument, connectErr.Code())
	require.Equal(t, "rendered document 1 could not be checked for Secret values", connectErr.Message())
	require.NotContains(t, connectErr.Message(), value)
	require.NotContains(t, connectErr.Message(), base64.RawStdEncoding.EncodeToString([]byte(value)))
	require.NotContains(t, connectErr.Message(), base64.StdEncoding.EncodeToString([]byte(value)))
}

// documentCheckError names the document's position, and nothing from the document.
func TestDocumentCheckErrorNamesOnlyThePosition(t *testing.T) {
	t.Parallel()
	require.EqualError(t, documentCheckError(3), "rendered document 3 could not be checked for Secret values")
}

// A node the encoder cannot write is refused, and the refusal names nothing from it. Both
// the document's own encoding and a later document's re-encoding refuse it, so neither
// is written and neither can fall back to the text as written.
func TestRedactionRefusesANodeTheEncoderCannotWrite(t *testing.T) {
	t.Parallel()
	node := &yaml.Node{Kind: 99, Value: treeScopeDesiredValue}
	text, keep, err := encodeDocument(node)
	require.Empty(t, text)
	require.False(t, keep)
	require.EqualError(t, err, "rendered document could not be re-encoded")

	view, err := nodeView(node)
	require.Nil(t, view)
	require.EqualError(t, err, "rendered document could not be re-encoded")
}

// A value of more than secretFormMaxLen bytes is still found in a copy of it, whole.
func TestRenderReplacesACopyOfALongValue(t *testing.T) {
	t.Parallel()
	value := strings.Repeat("long-value-", 12)
	rendered := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: shop-creds\n  annotations:\n    copied: " + value + "\n" +
		"stringData:\n  password: " + value + "\n"
	out, err := renderThroughServer(t, rendered)
	require.NoError(t, err)
	require.False(t, strings.Contains(out, value), "a copy of the long value was kept")
	require.Contains(t, out, "copied: <redacted>")
}

// A text that shares only the first secretFormMaxLen bytes of a value is replaced,
// since a copy of the value is matched by its prefix. The value is longer than the
// prefix, so only the prefix is searched for.
func TestRenderReplacesATextThatSharesOnlyTheFormPrefix(t *testing.T) {
	t.Parallel()
	value := strings.Repeat("long-value-", 12)
	shared := value[:secretFormMaxLen+4]
	rendered := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: shop-creds\n  annotations:\n    note: 'starts " + shared + " and goes on'\n" +
		"stringData:\n  password: " + value + "\n"
	out, err := renderThroughServer(t, rendered)
	require.NoError(t, err)
	require.NotContains(t, out, shared)
	require.Contains(t, out, "note: <redacted>")
}

// A top-level sequence whose node cannot be checked in place is refused. Here the
// Secret's stringData is anchored, so the sequence fails the render.
func TestRedactSecretManifestsRefusesASequenceWhoseNodeCannotBeChecked(t *testing.T) {
	t.Parallel()
	out, err := redactSecretManifests([]byte("- kind: Secret\n  metadata:\n    name: shop-creds\n  stringData: &s\n    password: " + treeScopeDesiredValue + "\n"))
	require.Nil(t, out)
	requireDocumentRefused(t, err, 1, treeScopeDesiredValue)
}

// A search set holds at most secretSetMaxForms distinct forms. A repeated form counts
// once. A set with one more distinct form matches every text, and builds no search, and
// the forms past the cap are not stored.
func TestFormCollectorMatchesEveryTextOnlyPastTheFormCap(t *testing.T) {
	t.Parallel()
	forms := make([]string, 0, secretSetMaxForms)
	for i := range secretSetMaxForms {
		forms = append(forms, fmt.Sprintf("form-%05d", i))
	}
	var within formCollector
	for _, f := range forms {
		within.add(f)
	}
	set := within.set()
	require.False(t, set.all)
	require.NotNil(t, set.repl)
	require.False(t, set.has("ordinary text"))
	require.True(t, set.has("contains form-00007 here"))

	var repeated formCollector
	for _, f := range append(forms, forms...) {
		repeated.add(f)
	}
	require.False(t, repeated.set().all, "repeated forms counted twice")

	var over formCollector
	for _, f := range append(forms, "form-extra") {
		over.add(f)
	}
	require.True(t, over.over)
	require.Nil(t, over.forms, "forms past the cap were stored")
	require.Nil(t, over.seen, "forms past the cap were stored")
	overSet := over.set()
	require.True(t, overSet.all)
	require.Nil(t, overSet.repl)
	require.True(t, overSet.has("ordinary text"))
	require.True(t, overSet.has(""))
}

// A Secret whose forms pass the cap is not searched: every other scalar outside data
// and stringData is replaced, and so is every comment that is kept. The identity
// fields are kept.
func TestRenderReplacesEveryScalarOfASecretPastTheFormCap(t *testing.T) {
	t.Parallel()
	var stringData strings.Builder
	for i := range 1500 {
		fmt.Fprintf(&stringData, "  key%04d: value-%04d-secret\n", i, i)
	}
	rendered := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: shop-creds\n  labels:\n    tier: backend\n" +
		"  annotations:\n    note: ordinary text\n# a comment about the Secret\n" +
		"stringData:\n" + stringData.String()
	view, err := decodeManifest([]byte(rendered))
	require.NoError(t, err)
	require.True(t, secretSetOf(view).all, "the fixture must pass the form cap")

	out, err := renderThroughServer(t, rendered)
	require.NoError(t, err)
	require.Contains(t, out, "name: shop-creds")
	require.Contains(t, out, "apiVersion: v1")
	require.Contains(t, out, "tier: <redacted>")
	require.Contains(t, out, "note: <redacted>")
	require.Contains(t, out, "key0007: <redacted>")
	require.NotContains(t, out, "backend")
	require.NotContains(t, out, "ordinary")
	require.NotContains(t, out, "a comment about")
	require.NotContains(t, out, "value-0007-secret")
}

// A decoded object past the form cap has each stray value replaced, whatever its type:
// a string, a number and a null.
func TestRedactionReplacesEveryDecodedScalarPastTheFormCap(t *testing.T) {
	t.Parallel()
	stringData := make(map[string]any)
	for i := range 1500 {
		stringData[fmt.Sprintf("key%04d", i)] = fmt.Sprintf("value-%04d-secret", i)
	}
	secret := map[string]any{
		"apiVersion": "v1",
		"kind":       "Secret",
		"metadata": map[string]any{
			"name": "creds",
			"annotations": map[string]any{
				"note":  "ordinary",
				"count": 7.0,
				"unset": nil,
			},
		},
		"stringData": stringData,
	}
	redactSecretValues(secret)
	meta, ok := secret["metadata"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, "creds", meta["name"])
	annotations, ok := meta["annotations"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, redactedSecretValue, annotations["note"])
	require.Equal(t, redactedSecretValue, annotations["count"])
	require.Equal(t, redactedSecretValue, annotations["unset"])
	require.Equal(t, redactedSecretValue, stringData["key0007"])
}

// The scan cap applies only when the Secret holds a form to search for. A Secret whose
// values are all shorter than secretFormMinLen has no form, so its long stray scalar is
// kept, while its short value is still replaced.
func TestRenderKeepsALongStrayScalarOfASecretWithNoForm(t *testing.T) {
	t.Parallel()
	long := strings.Repeat("z", secretScanCap+1)
	rendered := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: shop-creds\n  annotations:\n    long: " + long +
		"\nstringData:\n  short: abc\n"
	out, err := renderThroughServer(t, rendered)
	require.NoError(t, err)
	require.True(t, strings.Contains(out, "long: "+long), "a long scalar of a Secret with no form was replaced")
	require.Contains(t, out, "short: <redacted>")

	// The decoded path, which GetResource uses, has the same rule.
	secret := map[string]any{
		"kind":       "Secret",
		"metadata":   map[string]any{"name": "shop-creds", "annotations": map[string]any{"long": long}},
		"stringData": map[string]any{"short": "abc"},
	}
	redactSecretValues(secret)
	meta, ok := secret["metadata"].(map[string]any)
	require.True(t, ok)
	annotations, ok := meta["annotations"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, long, annotations["long"], "a long scalar of a Secret with no form was replaced")
	data, ok := secret["stringData"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, redactedSecretValue, data["short"])
}

// A document the controller cannot decode is refused when it is a Secret, a List, a
// kind-less Secret, or not plain: it has an alias, an anchor, a merge key, an explicit
// tag or a duplicate key. Each shape below holds a Secret value under a complex key, so
// the controller skips the document, and Render would otherwise return the value as
// written. The second kind key and the items alias are refused only because they are
// not plain. The binary-tagged kind is also refused as a kind-less Secret, since its
// text declares no string kind (its tag is !!binary). The others are refused by the
// Secret or kind-less rules as well.
func TestRedactSecretManifestsRefusesANonPlainDocumentTheControllerCannotDecode(t *testing.T) {
	t.Parallel()
	v := treeScopeDesiredValue
	complexKey := "? [a]\n: b\n"
	head := "metadata:\n  name: shop-creds\n"
	for _, tc := range []struct {
		name  string
		input string
		index int
	}{
		{"an alias kind whose anchor is a label value",
			"metadata:\n  name: shop-creds\n  labels:\n    tier: &k Secret\nkind: *k\nstringData:\n  password: " + v + "\n" + complexKey, 1},
		{"a binary-tagged kind",
			"kind: !!binary U2VjcmV0\n" + head + "stringData:\n  password: " + v + "\n" + complexKey, 1},
		{"a merge key that sets the kind",
			head + "<<: {kind: Secret}\nstringData:\n  password: " + v + "\n" + complexKey, 1},
		{"a second kind key after ConfigMap",
			"kind: ConfigMap\nkind: Secret\n" + head + "stringData:\n  password: " + v + "\n" + complexKey, 1},
		{"an anchored kind in a later document after a separator with a space",
			"kind: ConfigMap\nmetadata:\n  name: cfg\n--- \nmetadata:\n  name: shop-creds\n  labels:\n    tier: &k Secret\nkind: *k\nstringData:\n  password: " + v + "\n" + complexKey, 2},
		{"an items alias whose anchor holds a Secret item",
			"base: &i\n  - kind: Secret\n    metadata: {name: s}\n    stringData: {password: " + v + "}\nitems: *i\n" + complexKey, 1},
	} {
		out, err := redactSecretManifests([]byte(tc.input))
		require.Nil(t, out, tc.name)
		requireDocumentRefused(t, err, tc.index, v)
	}
}

// A document the controller cannot decode, with no alias, anchor, merge key, tag or
// duplicate key, is kept as written. A duplicate key in a document the controller reads
// is not refused either.
func TestRedactSecretManifestsKeepsAPlainDocumentThatIsNotRefused(t *testing.T) {
	t.Parallel()
	out, err := redactSecretManifests([]byte("kind: ConfigMap\nmetadata:\n  name: cfg\n? [a]\n: one\n"))
	require.NoError(t, err)
	require.Contains(t, string(out), "name: cfg")
	require.Contains(t, string(out), "one")

	out, err = redactSecretManifests([]byte("kind: ConfigMap\nmetadata:\n  name: cfg\n  labels:\n    tier: a\n    tier: b\n"))
	require.NoError(t, err)
	require.Contains(t, string(out), "name: cfg")
}

// A document with no kind that has data or stringData is redacted as a Secret. A
// misplaced end around a Secret header, or a separator between the header and its
// stringData, leaves such a document, and the controller skips it.
func TestRenderRedactsAKindlessDocumentWithSecretData(t *testing.T) {
	t.Parallel()
	v := treeScopeDesiredValue
	for _, tc := range []struct {
		name     string
		rendered string
	}{
		{"a misplaced end around a Secret header",
			"metadata: {name: s}\nstringData: {password: " + v + "}\n"},
		{"the same with base64 data",
			"metadata: {name: s}\ndata: {password: " + b64(v) + "}\n"},
		{"a separator between a Secret header and its stringData",
			"kind: Secret\nmetadata:\n  name: s\n---\nstringData:\n  password: " + v + "\n"},
		{"a CR separator inside one chunk",
			"kind: Secret\nmetadata:\n  name: s\n\r---\r" + "stringData:\n  password: " + v + "\n"},
		{"a U+2028 separator inside one chunk",
			"kind: Secret\nmetadata:\n  name: s\n --- " + "stringData:\n  password: " + v + "\n"},
		{"a separator with a space inside one chunk",
			"kind: Secret\nmetadata:\n  name: s\n--- \nstringData:\n  password: " + v + "\n"},
	} {
		out, err := renderThroughServer(t, tc.rendered)
		require.NoError(t, err, tc.name)
		require.NotContains(t, out, v, tc.name)
		require.NotContains(t, out, b64(v), tc.name)
		require.Contains(t, out, "password: <redacted>", tc.name)
	}
}

// A copy of a kind-less document's value elsewhere in it is replaced, and an items
// list of such a document keeps its item redaction, with its own stringData redacted too.
func TestRenderRedactsAKindlessDocumentsCopiesAndItems(t *testing.T) {
	t.Parallel()
	v := treeScopeDesiredValue
	rendered := "metadata:\n  name: s\n  annotations:\n    note: " + v + "\nstringData:\n  password: " + v + "\n"
	out, err := renderThroughServer(t, rendered)
	require.NoError(t, err)
	assertNoSecretValues(t, out)
	require.Contains(t, out, "note: <redacted>")

	items := "metadata:\n  name: list\nitems:\n- kind: Secret\n  metadata: {name: a}\n  stringData: {password: " + v + "}\n" +
		"stringData: {token: " + treeScopeRotatedValue + "}\n"
	out, err = renderThroughServer(t, items)
	require.NoError(t, err)
	assertNoSecretValues(t, out)
	require.Contains(t, out, "password: <redacted>")
	require.Contains(t, out, "token: <redacted>")
}

// A kind-less document with data or stringData that the controller cannot decode is
// refused, as an undecodable Secret is.
func TestRedactSecretManifestsRefusesAnUndecodableKindlessDocument(t *testing.T) {
	t.Parallel()
	v := treeScopeDesiredValue
	for _, input := range []string{
		"metadata:\n  name: s\nstringData:\n  password: " + v + "\n? [a]\n: b\n",
		"metadata:\n  name: s\ndata:\n  password: " + b64(v) + "\n? [a]\n: b\n",
	} {
		out, err := redactSecretManifests([]byte(input))
		require.Nil(t, out)
		requireDocumentRefused(t, err, 1, v)
	}
}

// A top-level mapping with no kind and neither data nor stringData is kept as written.
func TestRenderKeepsAKindlessDocumentWithNeitherDataNorStringData(t *testing.T) {
	t.Parallel()
	out, err := renderThroughServer(t, "metadata:\n  name: x\nfoo: bar\n")
	require.NoError(t, err)
	require.Contains(t, out, "name: x")
	require.Contains(t, out, "foo: bar")
}

// Each data and stringData value of a kind-less Secret becomes the marker, whatever its
// length, as a Secret's values do. A value shorter than the search minimum is not found
// by a search, so only the Secret redaction replaces it. Both the node and the decoded
// path are checked: the decoded path is taken when the document is not plain.
func TestRenderMarksEveryValueOfAKindlessSecret(t *testing.T) {
	t.Parallel()
	out, err := renderThroughServer(t, "metadata: {name: s}\nstringData:\n  pin: \"1\"\n  empty: \"\"\n")
	require.NoError(t, err)
	require.Contains(t, out, "pin: <redacted>")
	require.Contains(t, out, "empty: <redacted>")

	out, err = renderThroughServer(t, "metadata: {name: s}\nstringData:\n  pin: \"1\"\nnote: &n plain text\ncopy: *n\n")
	require.NoError(t, err)
	require.Contains(t, out, "pin: <redacted>")
	require.NotContains(t, out, "pin: \"1\"")
}

// A List item, or a top-level sequence item, whose kind is not a string is read as an
// item with no kind. Its values and a copy of them are redacted, even when the value is
// shorter than the search minimum, since the item is treated as a Secret.
func TestRenderRedactsASecretItemWhoseKindIsNotAString(t *testing.T) {
	t.Parallel()
	const pin = "12345"
	copied := `{"stringData":{"pin":"` + pin + `"}}`
	for _, kind := range []string{"~", "5", "yes", "\"\""} {
		list := "kind: List\nitems:\n- kind: " + kind + "\n  metadata:\n    name: a\n" +
			"    annotations:\n      kubectl.kubernetes.io/last-applied-configuration: '" + copied + "'\n" +
			"  stringData:\n    pin: \"" + pin + "\"\n"
		out, err := renderThroughServer(t, list)
		require.NoError(t, err, "kind %s", kind)
		require.NotContains(t, out, pin, "kind %s", kind)
		require.Contains(t, out, "pin: <redacted>", "kind %s", kind)
	}

	out, err := redactSecretManifests([]byte("- kind: ~\n  metadata:\n    name: a\n  stringData:\n    pin: \"" + pin + "\"\n"))
	require.NoError(t, err)
	require.NotContains(t, string(out), pin)
	require.Contains(t, string(out), "pin: <redacted>")
}

// A kind-less Secret's values are found when they sit under a merge key, which the
// document's own data and stringData do not show. The merged values are in the search
// set, so a copy of one elsewhere in the document is replaced, and the document is
// redacted as a Secret.
func TestRenderRedactsAKindlessSecretWhoseValuesComeFromAMergeKey(t *testing.T) {
	t.Parallel()
	v := treeScopeDesiredValue
	for _, tc := range []struct {
		name     string
		rendered string
	}{
		{"a merged stringData with a copy in a stray field",
			"metadata: {name: s}\n<<: {stringData: {password: " + v + "}}\nnote: " + v + "\n"},
		{"a merged data with a base64 copy in a stray field",
			"metadata: {name: s}\n<<: {data: {password: " + b64(v) + "}}\nnote: " + b64(v) + "\n"},
	} {
		out, err := renderThroughServer(t, tc.rendered)
		require.NoError(t, err, tc.name)
		require.NotContains(t, out, v, tc.name)
		require.NotContains(t, out, b64(v), tc.name)
		require.Contains(t, out, "note: <redacted>", tc.name)
	}
}

// A kind-less Secret's stringData value that is a number, and that is written with
// underscores, is also found as a copy in a stray field, from its written text.
func TestRenderRedactsAKindlessSecretNumericValueCopiedElsewhere(t *testing.T) {
	t.Parallel()
	const pin = "1_234_567_890_123"
	out, err := renderThroughServer(t, "metadata:\n  name: s\n  annotations:\n    note: \""+pin+" here\"\nstringData:\n  pin: "+pin+"\n")
	require.NoError(t, err)
	require.NotContains(t, out, pin)
	require.Contains(t, out, "note: <redacted>")
}

// A document whose kind is a YAML 1.1 scalar that is not a string, such as ~, null, yes
// or 5, has no kind to the controller. Its data and stringData are redacted as a
// kind-less Secret, whether the values are base64 or plain.
func TestRenderRedactsAKindlessSecretWhoseKindIsNotAString(t *testing.T) {
	t.Parallel()
	v := treeScopeDesiredValue
	for _, kind := range []string{"~", "null", "yes", "5"} {
		for _, tc := range []struct {
			name  string
			field string
		}{
			{"base64 data", "data: {password: " + b64(v) + "}\n"},
			{"stringData", "stringData: {password: " + v + "}\n"},
		} {
			rendered := "kind: " + kind + "\nmetadata: {name: s}\n" + tc.field
			out, err := renderThroughServer(t, rendered)
			require.NoError(t, err, "kind %s with %s", kind, tc.name)
			require.NotContains(t, out, v, "kind %s with %s", kind, tc.name)
			require.NotContains(t, out, b64(v), "kind %s with %s", kind, tc.name)
			require.Contains(t, out, "password: <redacted>", "kind %s with %s", kind, tc.name)
		}
	}
}

// A document whose kind is read as no string, after a kind that is a string, is judged
// by the controller's reading. A duplicate kind key takes the last value, so a later
// null, empty or bool kind leaves the document with no kind. The first kind is Secret
// or ConfigMap: a ConfigMap first kind would make a node-declared kind check pass, and
// the controller still reads no kind.
func TestRenderRedactsASecretWhoseLastKindIsNotAString(t *testing.T) {
	t.Parallel()
	v := treeScopeDesiredValue
	for _, first := range []string{"Secret", "ConfigMap"} {
		for _, kind := range []string{"~", "\"\"", "yes"} {
			rendered := "kind: " + first + "\nkind: " + kind + "\nmetadata: {name: s}\nstringData: {password: " + v + "}\n"
			out, err := renderThroughServer(t, rendered)
			require.NoError(t, err, "first kind %s, last kind %s", first, kind)
			require.NotContains(t, out, v, "first kind %s, last kind %s", first, kind)
			require.Contains(t, out, "password: <redacted>", "first kind %s, last kind %s", first, kind)
		}
	}
}

// A later document in a chunk, after a separator with a space, is judged on its own
// reading. Its kind ~ is no string, so its stringData is redacted as a kind-less Secret.
func TestRenderRedactsALaterKindlessDocumentWithSecretData(t *testing.T) {
	t.Parallel()
	v := treeScopeDesiredValue
	rendered := "kind: ConfigMap\nmetadata: {name: cfg}\n--- \nkind: ~\nmetadata: {name: s}\nstringData: {password: " + v + "}\n"
	out, err := renderThroughServer(t, rendered)
	require.NoError(t, err)
	require.NotContains(t, out, v)
	require.Contains(t, out, "name: cfg")
	require.Contains(t, out, "password: <redacted>")
}

// An undecodable document whose kind is ~ has no kind, so it is a kind-less Secret, and
// Render refuses it. A complex key makes the controller skip the document.
func TestRedactSecretManifestsRefusesAnUndecodableDocumentWhoseKindIsNotAString(t *testing.T) {
	t.Parallel()
	v := treeScopeDesiredValue
	for _, kind := range []string{"~", "null", "yes"} {
		input := "kind: " + kind + "\nmetadata: {name: s}\nstringData: {password: " + v + "}\n? [a]\n: b\n"
		out, err := redactSecretManifests([]byte(input))
		require.Nil(t, out, "kind %s", kind)
		requireDocumentRefused(t, err, 1, v)
	}
}

// A document whose kind is a string the controller reads is not a kind-less Secret. A
// merge key supplies the kind, so the controller reads ConfigMap, and its value is kept.
func TestRenderKeepsAConfigMapWhoseKindComesFromAMergeKey(t *testing.T) {
	t.Parallel()
	out, err := renderThroughServer(t, "<<: {kind: ConfigMap}\nmetadata: {name: cfg}\ndata: {k: plain-config-value}\n")
	require.NoError(t, err)
	require.Contains(t, out, "plain-config-value")
	require.NotContains(t, out, "<redacted>")
}

// A quoted kind that is a string is read as a kind, not as a YAML 1.1 bool. A List item
// of kind "yes" is an item of its own kind, so its copied-Secret annotation is kept. The
// item holds no data key, since an item with data or stringData is a Secret item.
func TestRenderKeepsAListItemWhoseQuotedKindIsYes(t *testing.T) {
	t.Parallel()
	const value = "12345"
	out, err := renderThroughServer(t, "kind: List\nitems:\n- kind: \"yes\"\n  metadata:\n    name: a\n    annotations: {kubectl.kubernetes.io/last-applied-configuration: '"+value+"'}\n")
	require.NoError(t, err)
	require.Contains(t, out, value)
	require.NotContains(t, out, "<redacted>")
}

// A Secret whose last kind key is another string has its values read from the
// document's second stringData key, which the node walk does not reach. A copy of one
// of those values in a stray field is replaced.
func TestRenderRedactsASecretWhoseLastKindIsAnotherStringAndCopiesSecondStringData(t *testing.T) {
	t.Parallel()
	v := treeScopeRotatedValue
	rendered := "kind: Secret\nkind: ConfigMap\nmetadata: {name: s}\nstringData: {password: " + treeScopeDesiredValue +
		"}\nstringData: {token: " + v + "}\nnote: " + v + "\n"
	out, err := renderThroughServer(t, rendered)
	require.NoError(t, err)
	require.NotContains(t, out, v)
	require.Contains(t, out, "note: <redacted>")
}

// A document with a duplicate items key, whose first value is a list of items with a
// Secret item, is redacted as a List even when its last items value is not a list. The
// document is re-encoded from the controller's object, which holds only the last items
// value, so the Secret item is not printed.
func TestRenderRedactsADocumentWithDuplicateItemsKeysWhoseLastValueIsNotAList(t *testing.T) {
	t.Parallel()
	v := treeScopeDesiredValue
	for _, last := range []string{"{x: 1}", "scalar", "~"} {
		rendered := "metadata: {name: l}\nitems:\n- kind: Secret\n  metadata: {name: a}\n  stringData: {password: " + v +
			"}\nitems: " + last + "\n"
		out, err := renderThroughServer(t, rendered)
		require.NoError(t, err, "last items %s", last)
		require.NotContains(t, out, v, "last items %s", last)
	}
}

// A List item that is read as a Secret, because it has no kind, a kind that is not a
// string, or sits in a SecretList, can hold a List of its own. The Secrets in that List
// are redacted in place, so a value shorter than the search minimum is not printed.
func TestRenderRedactsASecretInAListHeldByASecretItem(t *testing.T) {
	t.Parallel()
	const pin = "1234"
	nested := "  items:\n  - kind: Secret\n    metadata: {name: s}\n    stringData:\n      pin: \"" + pin + "\"\n"
	for _, tc := range []struct{ name, rendered string }{
		{"an item with no kind", "kind: List\nitems:\n- metadata: {name: l}\n" + nested},
		{"an item whose kind is ~", "kind: List\nitems:\n- kind: ~\n" + nested},
		{"an item whose kind is yes", "kind: List\nitems:\n- kind: yes\n" + nested},
		{"a List item of a SecretList", "kind: SecretList\nitems:\n- kind: List\n" + nested},
		{"a sequence item with no kind", "- metadata: {name: l}\n" + nested},
		{"an aliased item, read from the decoded object", "x: &a plain\nkind: List\nitems:\n- note: *a\n" + nested},
		{"a Secret with an items list", "kind: Secret\nmetadata: {name: s}\n" + nested[2:]},
		{"an anchored Secret with an items list", "x: &a plain\nnote: *a\nkind: Secret\nmetadata: {name: s}\n" + nested[2:]},
	} {
		out, err := renderThroughServer(t, tc.rendered)
		require.NoError(t, err, tc.name)
		require.NotContains(t, out, `"`+pin+`"`, tc.name)
		require.Contains(t, out, "pin: <redacted>", tc.name)
	}
}

// A Secret that holds the value Secret, and has an items list, is redacted with its
// items. The stray walk of the Secret must not rewrite the kind of a Secret item in the
// list, so the item's short value is still replaced. The rows are a List item with no
// kind, a top-level Secret, an anchored Secret, a sequence item and a decoded pair.
func TestRenderRedactsASecretItemHeldByAListWhoseSecretValueIsSecret(t *testing.T) {
	t.Parallel()
	const pin = "1234"
	nestedItem := "  items:\n  - kind: Secret\n    metadata: {name: s}\n    stringData: {pin: \"" + pin + "\"}\n"
	for _, tc := range []struct{ name, rendered string }{
		{"a List item with no kind", "kind: List\nitems:\n- metadata: {name: l}\n  stringData: {word: Secret}\n" + nestedItem},
		{"a top-level Secret", "kind: Secret\nmetadata: {name: s}\nstringData: {word: Secret}\n" + nestedItem[2:]},
		{"an anchored Secret", "x: &a plain\nkind: Secret\nmetadata: {name: s}\nstringData: {word: Secret}\nnote: *a\n" + nestedItem[2:]},
		{"a sequence item", "- metadata: {name: l}\n  stringData: {word: Secret}\n" + nestedItem},
	} {
		out, err := renderThroughServer(t, tc.rendered)
		require.NoError(t, err, tc.name)
		require.NotContains(t, out, `"`+pin+`"`, tc.name)
		require.Contains(t, out, "pin: <redacted>", tc.name)
	}

	desired, err := decodeManifest([]byte("kind: Secret\nmetadata: {name: s}\nstringData: {word: Secret}\n" + nestedItem[2:]))
	require.NoError(t, err)
	redactManifestPair(desired, nil)
	items, ok := desired["items"].([]any)
	require.True(t, ok)
	item, ok := items[0].(map[string]any)
	require.True(t, ok)
	itemData, ok := item["stringData"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, redactedSecretValue, itemData["pin"])
	stringData, ok := desired["stringData"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, redactedSecretValue, stringData["word"])
}

// A Secret with an items list is redacted with that list in a pair too: the Secret item in
// the list has its values replaced, and the pair holds no value.
func TestRedactManifestPairRedactsTheItemsOfASecret(t *testing.T) {
	t.Parallel()
	desired, err := decodeManifest([]byte("kind: Secret\nmetadata: {name: s}\nstringData: {pin: \"1234\"}\nitems:\n- kind: Secret\n  stringData: {pin: \"1234\"}\n"))
	require.NoError(t, err)
	redactManifestPair(desired, nil)
	require.Equal(t, map[string]any{
		"kind":       "Secret",
		"metadata":   map[string]any{"name": "s"},
		"stringData": map[string]any{"pin": redactedSecretValue},
		"items": []any{map[string]any{
			"kind":       "Secret",
			"stringData": map[string]any{"pin": redactedSecretValue},
		}},
	}, desired)
}

// A SecretList that holds a SecretList reads the items of the inner list as Secret
// items, so the copied-Secret annotation of a ConfigMap item there is replaced. The item
// has no data key, so only the SecretList reading redacts it. The rows are plain and
// anchored.
func TestRenderRedactsTheItemsOfANestedSecretList(t *testing.T) {
	t.Parallel()
	inner := "- kind: SecretList\n  items:\n  - kind: ConfigMap\n    metadata:\n      name: a\n" +
		"      annotations: {kubectl.kubernetes.io/last-applied-configuration: '{\"pin\":\"1234\"}'}\n"
	for _, tc := range []struct{ name, rendered string }{
		{"a plain SecretList", "kind: SecretList\nitems:\n" + inner},
		{"an anchored SecretList", "x: &a plain\nnote: *a\nkind: SecretList\nitems:\n" + inner},
	} {
		out, err := renderThroughServer(t, tc.rendered)
		require.NoError(t, err, tc.name)
		require.NotContains(t, out, "1234", tc.name)
		require.Contains(t, out, "last-applied-configuration: "+redactedSecretValue, tc.name)
	}
}

// A Secret with no items list is redacted as before: each stringData value is replaced
// whole, and the name is kept.
func TestRedactManifestPairRedactsASecretWithoutAnItemsListAsBefore(t *testing.T) {
	t.Parallel()
	desired, err := decodeManifest([]byte("kind: Secret\nmetadata: {name: s}\nstringData: {pin: \"1234\"}\n"))
	require.NoError(t, err)
	redactManifestPair(desired, nil)
	require.Equal(t, map[string]any{
		"kind":       "Secret",
		"metadata":   map[string]any{"name": "s"},
		"stringData": map[string]any{"pin": redactedSecretValue},
	}, desired)
}

// A value of a Secret that is copied into an identity field of an object in a List that
// the Secret holds is replaced, as a value copied into any other field is. The rows are a
// top-level Secret, a List held by a kind-less Secret item, and an anchored Secret, which
// is redacted as a decoded object.
func TestRenderRedactsAnIdentityCopyOfASecretValueInAHeldList(t *testing.T) {
	t.Parallel()
	const copied = "mysecretname"
	for _, tc := range []struct{ name, rendered string }{
		{"a top-level Secret", "kind: Secret\nmetadata: {name: s}\nstringData: {user: " + copied + "}\nitems:\n- kind: ConfigMap\n  metadata: {name: " + copied + "}\n"},
		{"a List held by a kind-less item", "kind: List\nitems:\n- stringData: {user: " + copied + "}\n  items:\n  - kind: ConfigMap\n    metadata: {name: " + copied + "}\n"},
		{"an anchored Secret", "x: &a plain\nkind: Secret\nmetadata: {name: s}\nstringData: {user: " + copied + "}\nnote: *a\nitems:\n- kind: ConfigMap\n  metadata: {name: " + copied + "}\n"},
	} {
		out, err := renderThroughServer(t, tc.rendered)
		require.NoError(t, err, tc.name)
		require.NotContains(t, out, copied, tc.name)
		require.Contains(t, out, "name: "+redactedSecretValue, tc.name)
	}
}

// A desired Secret that holds an items list has an identity copy of its value replaced in
// the pair too, as the Secret's own fields are.
func TestRedactManifestPairRedactsAnIdentityCopyInTheItemsOfASecret(t *testing.T) {
	t.Parallel()
	desired, err := decodeManifest([]byte("kind: Secret\nmetadata: {name: s}\nstringData: {user: mysecretname}\nitems:\n- kind: ConfigMap\n  metadata: {name: mysecretname}\n"))
	require.NoError(t, err)
	redactManifestPair(desired, nil)
	items, ok := desired["items"].([]any)
	require.True(t, ok)
	item, ok := items[0].(map[string]any)
	require.True(t, ok)
	require.Equal(t, map[string]any{"name": redactedSecretValue}, item["metadata"])
}

// The stray pass over a List that a Secret holds runs once, for the outermost holder, so
// redaction stays linear in how deep Secrets that hold Lists nest. A pass at every level
// would walk each held List again for every holder above it, so the allocations per level
// would grow with the depth. The chain is redacted on the node path, on the decoded path
// (its root holds an alias) and as a decoded pair. The test does not run in parallel,
// because AllocsPerRun counts the whole process.
func TestRedactionOfNestedHeldListsStaysLinear(t *testing.T) {
	const shallow, deep = 100, 400
	render := func(root string) func(depth int) func() {
		return func(depth int) func() {
			rendered := []byte(heldSecretChain(depth, root))
			return func() {
				_, err := redactSecretManifests(rendered)
				require.NoError(t, err)
			}
		}
	}
	for _, tc := range []struct {
		name string
		run  func(depth int) func()
	}{
		{"node path", render("")},
		{"decoded path", render("x: &a plain, note: *a, ")},
		{"pair", func(depth int) func() {
			return func() { redactManifestPair(heldSecretChainObject(depth), nil) }
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			perLevel := func(depth int) float64 {
				return testing.AllocsPerRun(2, tc.run(depth)) / float64(depth)
			}
			low, high := perLevel(shallow), perLevel(deep)
			t.Logf("allocations per level: %.0f at depth %d, %.0f at depth %d", low, shallow, high, deep)
			require.Less(t, high, 2*low, "allocations per level grow with the depth")
		})
	}
}

// heldSecretChain returns, in flow style, a Secret that holds a List whose one item is a
// Secret that holds a List, depth Secrets deep. root is written at the start of the
// outermost mapping.
func heldSecretChain(depth int, root string) string {
	var b strings.Builder
	for i := range depth {
		if i == 0 {
			b.WriteString("{" + root)
		} else {
			b.WriteString("{")
		}
		fmt.Fprintf(&b, "kind: Secret, metadata: {name: s%d}, stringData: {v: value-%04d}, items: [", i, i)
	}
	b.WriteString("{kind: ConfigMap, metadata: {name: last}}")
	for range depth {
		b.WriteString("]}")
	}
	return b.String() + "\n"
}

// heldSecretChainObject is heldSecretChain as a decoded object.
func heldSecretChainObject(depth int) map[string]any {
	inner := map[string]any{"kind": "ConfigMap", "metadata": map[string]any{"name": "last"}}
	for i := depth - 1; i >= 0; i-- {
		inner = map[string]any{
			"kind":       "Secret",
			"metadata":   map[string]any{"name": fmt.Sprintf("s%d", i)},
			"stringData": map[string]any{"v": fmt.Sprintf("value-%04d", i)},
			"items":      []any{inner},
		}
	}
	return inner
}

// A List item that yaml.v3 reads as a Secret, and the controller does not, has its values
// redacted as a Secret's. The rows are a duplicate kind, an alias kind, a duplicate List
// kind, a merge key and a duplicate Secret kind. The controller applies no List, so no
// value here is one it applies.
func TestRenderRedactsAnItemThatYamlReadsAsASecretWhoseValueIsShort(t *testing.T) {
	t.Parallel()
	const pin = "1234"
	for _, tc := range []struct{ name, rendered string }{
		{"a duplicate kind that yaml.v3 reads as Secret", "kind: List\nitems:\n- kind: Secret\n  kind: ConfigMap\n  data: {pin: \"" + pin + "\"}\n"},
		{"an alias kind", "x: &k ConfigMap\nkind: List\nitems:\n- kind: *k\n  stringData: {pin: \"" + pin + "\"}\n"},
		{"a duplicate List kind", "kind: SecretList\nkind: List\nitems:\n- kind: ConfigMap\n  stringData: {pin: \"" + pin + "\"}\n"},
		{"a merge key that supplies the kind", "kind: List\nitems:\n- <<: {kind: ConfigMap}\n  stringData: {pin: \"" + pin + "\"}\n"},
		{"a duplicate Secret kind in a SecretList", "kind: SecretList\nkind: Secret\nitems: [{kind: ConfigMap, data: {pin: \"" + pin + "\"}}]\n"},
	} {
		out, err := renderThroughServer(t, tc.rendered)
		require.NoError(t, err, tc.name)
		require.NotContains(t, out, pin, tc.name)
		require.Contains(t, out, redactedSecretValue, tc.name)
	}
}

// An item with data in a plain List is a Secret item whatever its kind, so its short value
// is redacted. A top-level sequence item with data is redacted the same way.
func TestRenderRedactsADataItemOfAPlainListAndOfATopLevelSequence(t *testing.T) {
	t.Parallel()
	const pin = "1234"
	for _, tc := range []struct{ name, rendered string }{
		{"a ConfigMap item of a plain List", "kind: List\nitems:\n- kind: ConfigMap\n  data: {pin: \"" + pin + "\"}\n"},
		{"a ConfigMap sequence item", "- kind: ConfigMap\n  data: {pin: \"" + pin + "\"}\n"},
	} {
		out, err := renderThroughServer(t, tc.rendered)
		require.NoError(t, err, tc.name)
		require.NotContains(t, out, pin, tc.name)
		require.Contains(t, out, "pin: "+redactedSecretValue, tc.name)
	}
}

// The copied-Secret annotations of a ConfigMap item of a SecretList are replaced, whether
// the SecretList is top-level, nested in a List, or a top-level sequence item. The item
// has no data key except where a row says so, so only the SecretList reading redacts it.
func TestRenderRedactsTheCopiedAnnotationsOfAnItemOfASecretList(t *testing.T) {
	t.Parallel()
	const item = "  - kind: ConfigMap\n    metadata:\n      name: a\n" +
		"      annotations: {kubectl.kubernetes.io/last-applied-configuration: '{\"pin\":\"1234\"}'}\n"
	for _, tc := range []struct{ name, rendered string }{
		{"a plain SecretList", "kind: SecretList\nitems:\n" + item},
		{"an anchored SecretList", "x: &a plain\nnote: *a\nkind: SecretList\nitems:\n" + item},
		{"a SecretList item of a List", "kind: List\nitems:\n- kind: SecretList\n  items:\n" + item},
		{"a SecretList item with data in a List", "kind: List\nitems:\n- kind: SecretList\n  data: {}\n  items:\n" + item},
		{"an anchored SecretList item with data in a List", "x: &a plain\nnote: *a\nkind: List\nitems:\n- kind: SecretList\n  data: {}\n  items:\n" + item},
		{"a SecretList sequence item with data", "- kind: SecretList\n  data: {}\n  items:\n" + item},
	} {
		out, err := renderThroughServer(t, tc.rendered)
		require.NoError(t, err, tc.name)
		require.NotContains(t, out, "1234", tc.name)
		require.Contains(t, out, "last-applied-configuration: "+redactedSecretValue, tc.name)
	}
}

// A value of a Secret that is copied into an identity field of an object in a List that a
// Secret or a kind-less item holds is replaced, whether the List is plain or decoded, and
// whether it is nested, or is the items of a top-level sequence's Secret item.
func TestRenderRedactsAnIdentityCopyInAListHeldByASecretItem(t *testing.T) {
	t.Parallel()
	const copied = "mysecretname"
	held := "  items:\n  - kind: ConfigMap\n    metadata: {name: " + copied + "}\n"
	for _, tc := range []struct{ name, rendered string }{
		{"an anchored kind List whose Secret item holds a List", "x: &a plain\nnote: *a\nkind: List\nitems:\n- kind: Secret\n  stringData: {user: " + copied + "}\n" + held},
		{"a Secret and a List kind on one node", "kind: Secret\nkind: List\nstringData: {user: " + copied + "}\nitems:\n- kind: ConfigMap\n  metadata: {name: " + copied + "}\n"},
		{"a plain kind-less root holding a List", "stringData: {user: " + copied + "}\nitems:\n- kind: ConfigMap\n  metadata: {name: " + copied + "}\n"},
		{"an anchored kind-less root holding a List", "x: &a plain\nnote: *a\nstringData: {user: " + copied + "}\nitems:\n- kind: ConfigMap\n  metadata: {name: " + copied + "}\n"},
		{"a sequence Secret item holding a List", "- kind: Secret\n  stringData: {user: " + copied + "}\n" + held},
		{"a plain List item of a List whose Secret item holds a List", "kind: List\nitems:\n- kind: List\n  items:\n  - kind: Secret\n    stringData: {user: " + copied + "}\n    items:\n    - kind: ConfigMap\n      metadata: {name: " + copied + "}\n"},
		{"an anchored List item of a List whose Secret item holds a List", "x: &a plain\nnote: *a\nkind: List\nitems:\n- kind: List\n  items:\n  - kind: Secret\n    stringData: {user: " + copied + "}\n    items:\n    - kind: ConfigMap\n      metadata: {name: " + copied + "}\n"},
	} {
		out, err := renderThroughServer(t, tc.rendered)
		require.NoError(t, err, tc.name)
		require.NotContains(t, out, copied, tc.name)
		require.Contains(t, out, "name: "+redactedSecretValue, tc.name)
	}
}

// A desired or live List, and a desired Secret, that holds an identity copy of a Secret
// value in an item of its held List have that copy replaced in the pair.
func TestRedactManifestPairRedactsAnIdentityCopyInAHeldList(t *testing.T) {
	t.Parallel()
	const copied = "mysecretname"
	for _, manifest := range []string{
		"kind: List\nitems:\n- kind: Secret\n  stringData: {user: " + copied + "}\n  items:\n  - kind: ConfigMap\n    metadata: {name: " + copied + "}\n",
		"kind: List\nitems:\n- kind: List\n  items:\n  - kind: Secret\n    stringData: {user: " + copied + "}\n    items:\n    - kind: ConfigMap\n      metadata: {name: " + copied + "}\n",
	} {
		desired, err := decodeManifest([]byte(manifest))
		require.NoError(t, err)
		redactManifestPair(desired, nil)
		text, err := encodeYAML(desired)
		require.NoError(t, err)
		require.NotContains(t, text, copied, manifest)
		require.Contains(t, text, "name: "+redactedSecretValue, manifest)
	}
}
