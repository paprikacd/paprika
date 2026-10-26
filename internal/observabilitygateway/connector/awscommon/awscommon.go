// Package awscommon carries the configuration, credential and client mechanics
// shared by the AWS observability connectors (CloudWatch Logs, CloudWatch
// Metrics, X-Ray, CloudTrail). It exists so each connector package holds only
// its backend's query-shape logic.
//
// Credentials are a JSON document with snake_case keys
// ({"access_key_id","secret_access_key","session_token"} — the same document
// the EKS cluster provider accepts, internal/clusterprovider/eks.go) or empty
// for the ambient SDK chain (IRSA, pod identity, IMDS, environment).
//
// Unlike the HTTP connectors, every AWS connector requires a region: it is
// the partition-wide routing key and there is no house default, so an absent
// document is connector.ErrNotConfigured rather than a meaningful zero value.
// The endpoint key exists so VPC endpoints and local emulators can stand in
// for the real service; the SDK signs requests either way.
package awscommon

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/smithy-go"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

// Keys the strict connector configuration document may carry. Anything else
// is a typo and fails fast at validation time; per-connector keys are passed
// in by the caller and returned undecoded from ParseConfig.
const (
	configKeyRegion          = "region"
	configKeyEndpoint        = "endpoint"
	configKeyInsecureSkipTLS = "insecureSkipTLS"
)

// Config is the decoded connector configuration document shared by the AWS
// connectors. Region is required — it routes every AWS call. Endpoint
// overrides the service's default AWS URL; it exists so in-cluster emulators
// (LocalStack, connector tests) and VPC endpoints can stand in for the real
// API. The AWS connectors send no extra request headers, so no "headers" key
// exists here; add it deliberately if a backend ever needs one.
//
// InsecureSkipTLS makes this connector's requests accept whatever
// certificate the backend presents, self-signed included. WARNING: this
// trades MITM protection for compatibility with self-signed in-cluster
// backends — never set it for endpoints outside the cluster.
type Config struct {
	Region          string
	Endpoint        string
	InsecureSkipTLS bool
}

// ParseConfig decodes the strict AWS connector configuration document — the
// required "region" string, the optional "endpoint" absolute http(s) URL and
// the optional "insecureSkipTLS" bool — and returns it as a Config together
// with the undecoded values of the caller's extraKeys, for the connector to
// interpret its own keys. Unknown keys, wrong types and unusable values are
// errors naming the key but never its value: configuration values can carry
// credential material, so errors must stay safe to print.
//
// An absent document, or one without a usable region, reports
// connector.ErrNotConfigured: unlike the HTTP connectors there is no default
// AWS region to fall back to.
func ParseConfig(config json.RawMessage, extraKeys []string) (Config, map[string]json.RawMessage, error) {
	if len(bytes.TrimSpace(config)) == 0 {
		return Config{}, nil, fmt.Errorf("%w: config key %q is required", connector.ErrNotConfigured, configKeyRegion)
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(config, &raw); err != nil {
		return Config{}, nil, fmt.Errorf("config: invalid JSON document: %w", err)
	}
	for key := range raw {
		if !allowedConfigKey(key, extraKeys) {
			return Config{}, nil, fmt.Errorf("config: unknown key %q", key)
		}
	}

	region, err := requiredRegion(raw)
	if err != nil {
		return Config{}, nil, err
	}
	cfg, err := decodeSharedConfig(raw, region)
	if err != nil {
		return Config{}, nil, err
	}

	extras := make(map[string]json.RawMessage, len(extraKeys))
	for _, key := range extraKeys {
		if value, ok := raw[key]; ok {
			extras[key] = value
		}
	}
	return cfg, extras, nil
}

// ValidateConfig checks the strict AWS connector configuration document ahead
// of use, before it is ever passed to a Query call.
func ValidateConfig(config json.RawMessage, extraKeys []string) error {
	_, _, err := ParseConfig(config, extraKeys)
	return err
}

// RequiredString decodes one required connector-specific key from the extras
// map ParseConfig returns — a logGroup, a namespace. A missing or blank value
// is connector.ErrNotConfigured; a non-string value names the key only.
func RequiredString(extras map[string]json.RawMessage, key string) (string, error) {
	value, ok := extras[key]
	if !ok {
		return "", fmt.Errorf("%w: config key %q is required", connector.ErrNotConfigured, key)
	}
	var decoded string
	if err := json.Unmarshal(value, &decoded); err != nil {
		return "", fmt.Errorf("config: key %q must be a string", key)
	}
	if strings.TrimSpace(decoded) == "" {
		return "", fmt.Errorf("%w: config key %q must be non-empty", connector.ErrNotConfigured, key)
	}
	return decoded, nil
}

// allowedConfigKey reports whether key belongs to the strict document: one of
// the shared keys, or one of the caller's connector-specific extras.
func allowedConfigKey(key string, extraKeys []string) bool {
	switch key {
	case configKeyRegion, configKeyEndpoint, configKeyInsecureSkipTLS:
		return true
	}
	for _, extra := range extraKeys {
		if key == extra {
			return true
		}
	}
	return false
}

// requiredRegion decodes and validates the region key: present, a string,
// non-empty after trimming.
func requiredRegion(raw map[string]json.RawMessage) (string, error) {
	value, ok := raw[configKeyRegion]
	if !ok {
		return "", fmt.Errorf("%w: config key %q is required", connector.ErrNotConfigured, configKeyRegion)
	}
	return decodeRegion(value)
}

// decodeSharedConfig decodes the two optional shared keys over a Config that
// already carries its region.
func decodeSharedConfig(raw map[string]json.RawMessage, region string) (Config, error) {
	cfg := Config{Region: region}
	if value, ok := raw[configKeyEndpoint]; ok {
		endpoint, err := decodeEndpoint(value)
		if err != nil {
			return Config{}, err
		}
		cfg.Endpoint = endpoint
	}
	if value, ok := raw[configKeyInsecureSkipTLS]; ok {
		if err := json.Unmarshal(value, &cfg.InsecureSkipTLS); err != nil {
			return Config{}, fmt.Errorf("config: key %q must be a bool", configKeyInsecureSkipTLS)
		}
	}
	return cfg, nil
}

// decodeRegion validates the region key's value: a non-empty string after
// trimming. The check is deliberately light — no partitions resolver — the
// region is validated by the first real call instead.
func decodeRegion(value json.RawMessage) (string, error) {
	var region string
	if err := json.Unmarshal(value, &region); err != nil {
		return "", fmt.Errorf("config: key %q must be a string", configKeyRegion)
	}
	if strings.TrimSpace(region) == "" {
		return "", fmt.Errorf("%w: config key %q must be a non-empty region", connector.ErrNotConfigured, configKeyRegion)
	}
	return region, nil
}

// decodeEndpoint validates the endpoint key's value: a string holding an
// absolute http(s) URL. The parse error text can quote the URL itself, which
// may embed userinfo credential material — so it is deliberately dropped and
// errors name only the key.
func decodeEndpoint(value json.RawMessage) (string, error) {
	var endpoint string
	if err := json.Unmarshal(value, &endpoint); err != nil {
		return "", fmt.Errorf("config: key %q must be a string", configKeyEndpoint)
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", fmt.Errorf("config: key %q must be an absolute http(s) URL", configKeyEndpoint)
	}
	return endpoint, nil
}

// credentialsDocument is the JSON shape the credential document carries —
// the same snake_case document the EKS cluster provider accepts.
//
//nolint:tagliatelle // credential document fields follow cloud JSON conventions.
type credentialsDocument struct {
	AccessKeyID     string `json:"access_key_id"`
	SecretAccessKey string `json:"secret_access_key"`
	SessionToken    string `json:"session_token,omitempty"` // #nosec G117 -- Private decode-only credential document; this field never enters an API response.
}

// CredentialsDecoder parses the credential document into a static provider.
// A nil or empty document selects the ambient SDK chain and yields a nil
// provider — not an error. A malformed document, or one missing either
// required key, is a caller bug — the secret's content is wrong — so it
// returns an error for the caller to map (the gateway's finishQuery maps it
// to a StateError result). Errors name the missing keys but never echo the
// document's values.
func CredentialsDecoder(credentialDocument []byte) (aws.CredentialsProvider, error) {
	if len(bytes.TrimSpace(credentialDocument)) == 0 {
		return nil, nil
	}
	var doc credentialsDocument
	if err := json.Unmarshal(credentialDocument, &doc); err != nil {
		return nil, fmt.Errorf("credential document is not valid JSON: %w", err)
	}
	if doc.AccessKeyID == "" || doc.SecretAccessKey == "" {
		return nil, errors.New("credential document requires access_key_id and secret_access_key")
	}
	return credentials.NewStaticCredentialsProvider(doc.AccessKeyID, doc.SecretAccessKey, doc.SessionToken), nil
}

// NewAWSConfig assembles the aws.Config one query needs: region from the
// config document, static credentials from the credential document or the
// ambient SDK chain otherwise, and — when insecureSkipTLS is set — an HTTP
// client accepting self-signed certificates. Endpoint application stays
// per-service: each AWS client's BaseEndpoint option points it at a VPC
// endpoint or emulator.
func NewAWSConfig(ctx context.Context, cfg Config, credentialDocument []byte) (aws.Config, error) {
	options := []func(*awsconfig.LoadOptions) error{awsconfig.WithRegion(cfg.Region)}

	provider, err := CredentialsDecoder(credentialDocument)
	if err != nil {
		return aws.Config{}, err
	}
	if provider != nil {
		options = append(options, awsconfig.WithCredentialsProvider(provider))
	}
	if cfg.InsecureSkipTLS {
		options = append(options, awsconfig.WithHTTPClient(insecureHTTPClient))
	}

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, options...)
	if err != nil {
		return aws.Config{}, fmt.Errorf("loading aws config: %w", err)
	}
	return awsCfg, nil
}

// insecureTransport serves connectors whose config sets InsecureSkipTLS. It
// mirrors httphelp's sharedTransport knob for knob so the insecure variant
// changes only TLS verification, keeping the opt-in scoped to this one
// client's pool rather than the shared default.
//
//nolint:gosec // G402: opt-in per connector config; the Config doc carries the MITM trade-off warning.
var insecureTransport = &http.Transport{
	Proxy:                 http.ProxyFromEnvironment,
	MaxIdleConns:          32,
	MaxIdleConnsPerHost:   8,
	IdleConnTimeout:       90 * time.Second,
	TLSHandshakeTimeout:   10 * time.Second,
	ExpectContinueTimeout: time.Second,
	TLSClientConfig:       &tls.Config{InsecureSkipVerify: true},
}

// insecureHTTPClient serves connectors whose config sets InsecureSkipTLS. It
// has its own connection pool so verified and unverified TLS sessions never
// share keepalive state.
var insecureHTTPClient = &http.Client{Transport: insecureTransport}

// forbiddenErrorCodes are the smithy error codes AWS returns when the
// credential itself was refused — the distinction an operator acts on. The
// list mirrors the EKS cluster provider's mapAWSError
// (internal/clusterprovider/eks.go): exact code matches, with the
// ExpiredToken family covered in both its plain and Exception forms.
// Anything else is a plain backend failure and maps to StateError.
var forbiddenErrorCodes = map[string]struct{}{
	"AccessDenied":                {},
	"AccessDeniedException":       {},
	"AuthFailure":                 {},
	"ExpiredToken":                {},
	"ExpiredTokenException":       {},
	"InvalidAccessKeyId":          {},
	"InvalidClientTokenId":        {},
	"SignatureDoesNotMatch":       {},
	"UnrecognizedClientException": {},
}

// ClassifyError maps a failed AWS call onto the connector state vocabulary:
// a credential refusal reported by the service is StateForbidden; everything
// else — transport failures, throttling, missing resources — is StateError.
// Smithy's ErrorCode is the stable signal; message text is never inspected,
// because it can carry endpoint and account detail that must not reach status.
func ClassifyError(err error) connector.State {
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		if _, denied := forbiddenErrorCodes[apiErr.ErrorCode()]; denied {
			return connector.StateForbidden
		}
	}
	return connector.StateError
}

// ReasonFor returns the fixed user-facing sentence for a classified state.
// It delegates to httphelp so every connector reports the same sentence for
// the same backend failure.
func ReasonFor(state connector.State) string {
	return httphelp.ReasonFor(state)
}
