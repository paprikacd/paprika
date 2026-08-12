package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

const (
	CLIRedirectURL       = "http://127.0.0.1:17632/callback"
	maxTokenResponseSize = 1 << 20
	oidcHTTPTimeout      = 15 * time.Second
)

// OIDCConfig configures OpenID Connect authentication.
type OIDCConfig struct {
	IssuerURL    string
	ClientID     string
	ClientSecret string
	RedirectURL  string
	Scopes       []string
	GroupsClaim  string
	EmailClaim   string
	NameClaim    string
	HTTPClient   *http.Client
}

// OIDCAuthenticator validates OIDC bearer tokens.
type OIDCAuthenticator struct {
	provider     *oidc.Provider
	verifier     *oidc.IDTokenVerifier
	oauth2Config oauth2.Config
	httpClient   *http.Client
	groupsClaim  string
	emailClaim   string
	nameClaim    string
}

// NewOIDCAuthenticator creates a new OIDC authenticator.
func NewOIDCAuthenticator(ctx context.Context, cfg *OIDCConfig) (*OIDCAuthenticator, error) {
	if cfg.IssuerURL == "" {
		return nil, errors.New("oidc issuer URL is required")
	}
	if cfg.ClientID == "" {
		return nil, errors.New("oidc client ID is required")
	}

	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: oidcHTTPTimeout}
	}
	providerCtx := context.WithValue(ctx, oauth2.HTTPClient, httpClient)
	provider, err := oidc.NewProvider(providerCtx, cfg.IssuerURL)
	if err != nil {
		return nil, fmt.Errorf("create OIDC provider: %w", err)
	}

	scopes := cfg.Scopes
	if len(scopes) == 0 {
		scopes = []string{oidc.ScopeOpenID, "profile", "email", "groups"}
	}

	oauth2Config := oauth2.Config{
		ClientID:     cfg.ClientID,
		ClientSecret: cfg.ClientSecret,
		RedirectURL:  cfg.RedirectURL,
		Endpoint:     provider.Endpoint(),
		Scopes:       scopes,
	}

	verifier := provider.Verifier(&oidc.Config{
		ClientID: cfg.ClientID,
	},
	)

	return &OIDCAuthenticator{
		provider:     provider,
		verifier:     verifier,
		oauth2Config: oauth2Config,
		httpClient:   httpClient,
		groupsClaim:  defaultString(cfg.GroupsClaim, "groups"),
		emailClaim:   defaultString(cfg.EmailClaim, "email"),
		nameClaim:    defaultString(cfg.NameClaim, "name"),
	}, nil
}

// Authenticate validates the Bearer token from the Authorization header.
func (o *OIDCAuthenticator) Authenticate(ctx context.Context) (*Principal, error) {
	req, err := requestFromContext(ctx)
	if err != nil {
		return nil, errors.Join(err, ErrUnauthenticated)
	}

	auth := req.Header().Get("Authorization")
	if auth == "" {
		return nil, ErrUnauthenticated
	}

	parts := strings.SplitN(auth, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return nil, fmt.Errorf("invalid authorization header: %w", ErrUnauthenticated)
	}

	rawToken := parts[1]

	var cancel context.CancelFunc
	ctx, cancel = context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	token, err := o.verifier.Verify(ctx, rawToken)
	if err != nil {
		return nil, errors.Join(err, ErrUnauthenticated)
	}

	var claims map[string]interface{}
	if err := token.Claims(&claims); err != nil {
		return nil, errors.Join(fmt.Errorf("parse claims: %w", err), ErrUnauthenticated)
	}

	principal := &Principal{
		Subject: token.Subject,
		Claims:  claims,
	}

	if v, ok := claims[o.emailClaim].(string); ok {
		principal.Email = v
	}
	if v, ok := claims[o.nameClaim].(string); ok {
		principal.Name = v
	}
	if v, ok := claims[o.groupsClaim]; ok {
		principal.Groups = stringSlice(v)
	}

	return principal, nil
}

// OAuth2Config returns the OAuth2 config for the login flow.
func (o *OIDCAuthenticator) OAuth2Config() oauth2.Config {
	return o.oauth2Config
}

func (o *OIDCAuthenticator) validateRedirectURL(redirectURL string) (string, error) {
	if redirectURL == "" {
		redirectURL = o.oauth2Config.RedirectURL
	}
	if redirectURL == "" {
		return "", errors.New("redirect URI is required")
	}
	if redirectURL != o.oauth2Config.RedirectURL && redirectURL != CLIRedirectURL {
		return "", errors.New("redirect URI is not allowed")
	}
	return redirectURL, nil
}

func defaultString(a, b string) string {
	if a == "" {
		return b
	}
	return a
}

func stringSlice(v interface{}) []string {
	switch val := v.(type) {
	case []string:
		return val
	case []interface{}:
		result := make([]string, 0, len(val))
		for _, item := range val {
			if s, ok := item.(string); ok {
				result = append(result, s)
			}
		}
		return result
	case string:
		return []string{val}
	default:
		return nil
	}
}
