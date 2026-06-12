package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
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
}

// OIDCAuthenticator validates OIDC bearer tokens.
type OIDCAuthenticator struct {
	provider     *oidc.Provider
	verifier     *oidc.IDTokenVerifier
	oauth2Config oauth2.Config
	groupsClaim  string
	emailClaim   string
	nameClaim    string
}

// NewOIDCAuthenticator creates a new OIDC authenticator.
func NewOIDCAuthenticator(ctx context.Context, cfg *OIDCConfig) (*OIDCAuthenticator, error) {
	if cfg.IssuerURL == "" {
		return nil, errors.New("OIDC issuer URL is required")
	}
	if cfg.ClientID == "" {
		return nil, errors.New("OIDC client ID is required")
	}

	provider, err := oidc.NewProvider(ctx, cfg.IssuerURL)
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
		groupsClaim:  defaultString(cfg.GroupsClaim, "groups"),
		emailClaim:   defaultString(cfg.EmailClaim, "email"),
		nameClaim:    defaultString(cfg.NameClaim, "name"),
	}, nil
}

// Authenticate validates the Bearer token from the Authorization header.
func (o *OIDCAuthenticator) Authenticate(ctx context.Context) (*Principal, error) {
	req, err := requestFromContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrUnauthenticated, err)
	}

	auth := req.Header().Get("Authorization")
	if auth == "" {
		return nil, ErrUnauthenticated
	}

	parts := strings.SplitN(auth, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return nil, fmt.Errorf("%w: invalid authorization header", ErrUnauthenticated)
	}

	rawToken := parts[1]

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	token, err := o.verifier.Verify(ctx, rawToken)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrUnauthenticated, err)
	}

	var claims map[string]interface{}
	if err := token.Claims(&claims); err != nil {
		return nil, fmt.Errorf("%w: parse claims: %w", ErrUnauthenticated, err)
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
