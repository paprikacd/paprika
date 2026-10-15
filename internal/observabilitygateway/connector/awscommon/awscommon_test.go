package awscommon

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"

	"github.com/aws/smithy-go"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

func TestParseConfig(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		config  string
		extras  []string
		want    Config
		wantRaw map[string]json.RawMessage
		wantErr string
	}{
		{
			name:   "region only",
			config: `{"region":"us-east-1"}`,
			want:   Config{Region: "us-east-1"},
		},
		{
			name:   "full document",
			config: `{"region":"eu-west-2","endpoint":"https://logs.example.com","insecureSkipTLS":true}`,
			want:   Config{Region: "eu-west-2", Endpoint: "https://logs.example.com", InsecureSkipTLS: true},
		},
		{
			name:   "extra keys pass through undecoded",
			config: `{"region":"us-east-1","logGroup":"/aws/eks/prod","namespace":"AWS/ECS"}`,
			extras: []string{"logGroup", "namespace"},
			want:   Config{Region: "us-east-1"},
			wantRaw: map[string]json.RawMessage{
				"logGroup":  json.RawMessage(`"/aws/eks/prod"`),
				"namespace": json.RawMessage(`"AWS/ECS"`),
			},
		},
		{
			name:    "empty document",
			config:  ``,
			wantErr: connector.ErrNotConfigured.Error(),
		},
		{
			name:    "missing region",
			config:  `{"endpoint":"https://logs.example.com"}`,
			wantErr: `config key "region" is required`,
		},
		{
			name:    "blank region",
			config:  `{"region":"   "}`,
			wantErr: `config key "region" must be a non-empty region`,
		},
		{
			name:    "region not a string",
			config:  `{"region":42}`,
			wantErr: `key "region" must be a string`,
		},
		{
			name:    "endpoint not a string",
			config:  `{"region":"us-east-1","endpoint":42}`,
			wantErr: `key "endpoint" must be a string`,
		},
		{
			name:    "endpoint not absolute http",
			config:  `{"region":"us-east-1","endpoint":"logs.example.com"}`,
			wantErr: `key "endpoint" must be an absolute http(s) URL`,
		},
		{
			name:    "insecureSkipTLS not a bool",
			config:  `{"region":"us-east-1","insecureSkipTLS":"yes"}`,
			wantErr: `key "insecureSkipTLS" must be a bool`,
		},
		{
			name:    "unknown key",
			config:  `{"region":"us-east-1","step":"15s"}`,
			wantErr: `unknown key "step"`,
		},
		{
			name:    "unknown extra still rejected",
			config:  `{"region":"us-east-1","step":"15s"}`,
			extras:  []string{"logGroup"},
			wantErr: `unknown key "step"`,
		},
		{
			name:    "invalid JSON",
			config:  `{"region":`,
			wantErr: "invalid JSON document",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			cfg, extras, err := ParseConfig(json.RawMessage(tt.config), tt.extras)
			if tt.wantErr != "" {
				require.ErrorContains(t, err, tt.wantErr)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tt.want, cfg)
			if tt.wantRaw == nil {
				tt.wantRaw = map[string]json.RawMessage{}
			}
			require.Equal(t, tt.wantRaw, extras)
		})
	}
}

func TestValidateConfig(t *testing.T) {
	t.Parallel()

	require.NoError(t, ValidateConfig(json.RawMessage(`{"region":"us-east-1"}`), nil))
	require.ErrorIs(t, ValidateConfig(json.RawMessage(`{"logGroup":"g"}`), []string{"logGroup"}), connector.ErrNotConfigured)
	require.ErrorContains(t, ValidateConfig(json.RawMessage(`{"regoin":"us-east-1"}`), nil), `unknown key "regoin"`)
}

func TestRequiredString(t *testing.T) {
	t.Parallel()

	extras := map[string]json.RawMessage{
		"logGroup":  json.RawMessage(`"/aws/eks/prod"`),
		"namespace": json.RawMessage(`"AWS/ECS"`),
		"blank":     json.RawMessage(`"  "`),
		"wrongType": json.RawMessage(`42`),
	}

	value, err := RequiredString(extras, "logGroup")
	require.NoError(t, err)
	require.Equal(t, "/aws/eks/prod", value)

	_, err = RequiredString(extras, "missing")
	require.ErrorIs(t, err, connector.ErrNotConfigured)
	require.ErrorContains(t, err, `config key "missing" is required`)

	_, err = RequiredString(extras, "blank")
	require.ErrorIs(t, err, connector.ErrNotConfigured)
	require.ErrorContains(t, err, `config key "blank" must be non-empty`)

	_, err = RequiredString(extras, "wrongType")
	require.ErrorContains(t, err, `key "wrongType" must be a string`)
}

func TestCredentialsDecoder(t *testing.T) {
	t.Parallel()

	// Nil and empty documents select the ambient SDK chain — not an error.
	provider, err := CredentialsDecoder(nil)
	require.NoError(t, err)
	require.Nil(t, provider)
	provider, err = CredentialsDecoder([]byte("   "))
	require.NoError(t, err)
	require.Nil(t, provider)

	// A static document yields a static provider resolving to its keys.
	provider, err = CredentialsDecoder([]byte(`{"access_key_id":"AKID","secret_access_key":"SECRET"}`))
	require.NoError(t, err)
	require.NotNil(t, provider)
	creds, err := provider.Retrieve(context.Background())
	require.NoError(t, err)
	require.Equal(t, "AKID", creds.AccessKeyID)
	require.Equal(t, "SECRET", creds.SecretAccessKey)
	require.Empty(t, creds.SessionToken)

	// The optional session token rides along.
	provider, err = CredentialsDecoder([]byte(`{"access_key_id":"AKID","secret_access_key":"SECRET","session_token":"TOKEN"}`))
	require.NoError(t, err)
	creds, err = provider.Retrieve(context.Background())
	require.NoError(t, err)
	require.Equal(t, "TOKEN", creds.SessionToken)

	// Malformed JSON and missing keys are caller bugs: errors, naming the
	// keys but never the values.
	_, err = CredentialsDecoder([]byte("{"))
	require.ErrorContains(t, err, "credential document is not valid JSON")
	_, err = CredentialsDecoder([]byte(`["not","an","object"]`))
	require.ErrorContains(t, err, "credential document is not valid JSON")
	_, err = CredentialsDecoder([]byte(`{"access_key_id":"AKID"}`))
	require.ErrorContains(t, err, "credential document requires access_key_id and secret_access_key")
}

func TestNewAWSConfig(t *testing.T) {
	t.Parallel()

	cfg, err := NewAWSConfig(context.Background(), Config{Region: "us-east-1"}, []byte(`{"access_key_id":"AKID","secret_access_key":"SECRET"}`))
	require.NoError(t, err)
	require.Equal(t, "us-east-1", cfg.Region)

	// Ambient identity assembles fine; resolution happens on the first call.
	cfg, err = NewAWSConfig(context.Background(), Config{Region: "eu-west-2"}, nil)
	require.NoError(t, err)
	require.Equal(t, "eu-west-2", cfg.Region)

	_, err = NewAWSConfig(context.Background(), Config{Region: "us-east-1"}, []byte("{"))
	require.ErrorContains(t, err, "credential document is not valid JSON")
}

func TestNewAWSConfigAmbientResolvesNothing(t *testing.T) {
	// Not parallel: mutates the process AWS environment so the SDK's
	// credential chain fails deterministically regardless of the developer's
	// ~/.aws setup.
	emptyDir := t.TempDir()
	t.Setenv("AWS_ACCESS_KEY_ID", "")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "")
	t.Setenv("AWS_SESSION_TOKEN", "")
	t.Setenv("AWS_SHARED_CREDENTIALS_FILE", filepath.Join(emptyDir, "credentials"))
	t.Setenv("AWS_CONFIG_FILE", filepath.Join(emptyDir, "config"))
	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")

	cfg, err := NewAWSConfig(context.Background(), Config{Region: "us-east-1"}, nil)
	require.NoError(t, err)

	// The first credential lookup must fail — a StateError signal at Query
	// time, never a Forbidden one, because nothing was refused.
	_, err = cfg.Credentials.Retrieve(context.Background())
	require.Error(t, err)
	var apiErr smithy.APIError
	require.False(t, errors.As(err, &apiErr))
}

func TestClassifyError(t *testing.T) {
	t.Parallel()

	for code := range forbiddenErrorCodes {
		res := ClassifyError(&smithy.GenericAPIError{Code: code, Message: "detail never surfaces"})
		require.Equal(t, connector.StateForbidden, res, code)
	}

	require.Equal(t, connector.StateError, ClassifyError(&smithy.GenericAPIError{Code: "ThrottlingException", Message: "slow down"}))
	require.Equal(t, connector.StateError, ClassifyError(&smithy.GenericAPIError{Code: "ResourceNotFoundException", Message: "gone"}))
	require.Equal(t, connector.StateError, ClassifyError(errors.New("connection refused")))
	require.Equal(t, connector.StateError, ClassifyError(nil))
}

func TestReasonForDelegates(t *testing.T) {
	t.Parallel()

	require.Equal(t, "", ReasonFor(connector.StateOK))
	require.Equal(t, "the observability backend refused the supplied credentials", ReasonFor(connector.StateForbidden))
	require.Equal(t, "the observability backend query failed", ReasonFor(connector.StateError))
}
