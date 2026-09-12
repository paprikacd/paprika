package mcp

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/benebsworth/paprika/internal/cache"
)

var (
	// ErrConfirmInvalid also covers expiry: the cache TTL removes the key, so an
	// expired token is indistinguishable from one that never existed. There is
	// deliberately no separate ErrConfirmExpired — it could never be returned.
	ErrConfirmInvalid = errors.New("confirmation token not found or expired")
	// ErrConfirmUsed is returned when a token has already been consumed,
	// including a consumption that was itself rejected for a binding
	// mismatch: either way the token is burned and cannot be retried.
	ErrConfirmUsed = errors.New("confirmation token already used")
	// ErrConfirmMismatch is returned when a token is presented against a
	// different principal, tool, or argument set than the one it was issued
	// for.
	ErrConfirmMismatch = errors.New("confirmation token does not match this request")
)

// Confirmer issues single-use tokens that bind a destructive tool call to a
// principal, a tool name, and an exact argument set, so a confirmation
// obtained for one action cannot be replayed or probed against another. This
// is the server-side control that keeps a human in the loop: read tools may
// feed untrusted content (logs, annotations) into a model's context, and a
// confirmation token stops a crafted instruction in that content from
// authorising a write it never saw approved.
type Confirmer struct {
	cache *cache.Cache
	ttl   time.Duration
}

// NewConfirmer builds a Confirmer backed by c. Tokens live for ttl, which is
// the cache's own expiry — there is no separate expiry clock.
func NewConfirmer(c *cache.Cache, ttl time.Duration) *Confirmer {
	return &Confirmer{cache: c, ttl: ttl}
}

// confirmRecord is the value stored against a live token. ArgsHash binds the
// token to the exact arguments it was issued for, not merely the tool.
type confirmRecord struct {
	Principal string `json:"principal"`
	Tool      string `json:"tool"`
	ArgsHash  string `json:"argsHash"`
}

func argsHash(args json.RawMessage) string {
	sum := sha256.Sum256(args)
	return hex.EncodeToString(sum[:])
}

func (c *Confirmer) recordKey(token string) string {
	return "mcp:confirm:" + token
}

func (c *Confirmer) usedKey(token string) string {
	return "mcp:confirm:" + token + ":used"
}

// Issue records a pending confirmation for (principal, tool, args) and
// returns an opaque, cryptographically random token that a second call to
// Consume must present unchanged.
func (c *Confirmer) Issue(ctx context.Context, principal, tool string, args json.RawMessage) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate confirmation token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)

	payload, err := json.Marshal(confirmRecord{
		Principal: principal,
		Tool:      tool,
		ArgsHash:  argsHash(args),
	})
	if err != nil {
		return "", fmt.Errorf("marshal confirmation record: %w", err)
	}

	if err := c.cache.Set(ctx, c.recordKey(token), payload, c.ttl); err != nil {
		return "", fmt.Errorf("store confirmation token: %w", err)
	}
	return token, nil
}

// Consume validates token against (principal, tool, args) and retires it so
// it cannot be used again.
//
// Order matters here. A replayed token — one already consumed, whether that
// prior consumption succeeded or was rejected for a mismatch — must report
// ErrConfirmUsed rather than the vaguer ErrConfirmInvalid, so checkNotUsed
// runs first. An unknown or expired token (the cache simply has no record)
// reports ErrConfirmInvalid; expiry and never-existed are indistinguishable
// by design. Once a live record is found, burn deletes and tombstones it
// *before* the binding is validated, so a caller who gets the principal,
// tool, or argument hash wrong still burns the token: nothing is left alive
// to keep probing against.
func (c *Confirmer) Consume(ctx context.Context, token, principal, tool string, args json.RawMessage) error {
	if err := c.checkNotUsed(ctx, token); err != nil {
		return err
	}
	rec, err := c.burn(ctx, token)
	if err != nil {
		return err
	}
	return rec.matches(principal, tool, args)
}

// checkNotUsed reports ErrConfirmUsed if token was already consumed.
func (c *Confirmer) checkNotUsed(ctx context.Context, token string) error {
	used, err := c.cache.Get(ctx, c.usedKey(token))
	if err != nil {
		return fmt.Errorf("check confirmation token: %w", err)
	}
	if len(used) > 0 {
		return ErrConfirmUsed
	}
	return nil
}

// burn looks up the live record for token and, if found, retires it —
// deleting the record and writing a tombstone — before returning it, so the
// token cannot be consumed or probed again regardless of what the caller
// does with the returned record.
func (c *Confirmer) burn(ctx context.Context, token string) (confirmRecord, error) {
	var rec confirmRecord

	payload, err := c.cache.Get(ctx, c.recordKey(token))
	if err != nil {
		return rec, fmt.Errorf("check confirmation token: %w", err)
	}
	if len(payload) == 0 {
		return rec, ErrConfirmInvalid
	}

	if err := c.cache.Delete(ctx, c.recordKey(token)); err != nil {
		return rec, fmt.Errorf("retire confirmation token: %w", err)
	}
	if err := c.cache.Set(ctx, c.usedKey(token), []byte("1"), c.ttl); err != nil {
		return rec, fmt.Errorf("tombstone confirmation token: %w", err)
	}

	if err := json.Unmarshal(payload, &rec); err != nil {
		return rec, fmt.Errorf("unmarshal confirmation record: %w", err)
	}
	return rec, nil
}

// matches reports ErrConfirmMismatch unless rec was issued for exactly this
// principal, tool, and argument set. The argument hash comparison is
// constant-time so a caller cannot learn anything about the expected hash
// from response timing.
func (rec confirmRecord) matches(principal, tool string, args json.RawMessage) error {
	if rec.Principal != principal || rec.Tool != tool {
		return ErrConfirmMismatch
	}
	if subtle.ConstantTimeCompare([]byte(rec.ArgsHash), []byte(argsHash(args))) != 1 {
		return ErrConfirmMismatch
	}
	return nil
}
