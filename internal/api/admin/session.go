package admin

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/types"
)

const (
	AccessMode = "kubernetes-port-forward-admin"

	sessionTokenBytes       = 32
	sessionIdleLifetime     = 10 * time.Minute
	sessionAbsoluteLifetime = 30 * time.Minute
	maxTokenAttempts        = 16
)

var (
	ErrInvalidSession  = errors.New("invalid admin session")
	ErrSessionExpired  = errors.New("admin session expired")
	ErrTokenGeneration = errors.New("admin session token generation failed")
)

type Clock interface {
	Now() time.Time
}

type TokenSource interface {
	Token() ([sessionTokenBytes]byte, error)
}

type SystemClock struct{}

func (SystemClock) Now() time.Time {
	return time.Now()
}

type CryptoTokenSource struct{}

func (CryptoTokenSource) Token() ([sessionTokenBytes]byte, error) {
	var token [sessionTokenBytes]byte
	_, err := rand.Read(token[:])
	if err != nil {
		return [sessionTokenBytes]byte{}, fmt.Errorf("read cryptographic entropy: %w", err)
	}
	return token, nil
}

type ReviewedIdentity struct {
	Username string
	Groups   []string
	Extra    map[string][]string
}

type SessionDescription struct {
	Subject      string    `json:"subject"`
	AccessMode   string    `json:"accessMode"`
	IdleExpires  time.Time `json:"idleExpiresAt"`
	AbsoluteEnds time.Time `json:"absoluteExpiresAt"`
	PodUID       types.UID `json:"-"`
}

type ValidatedSession struct {
	Identity    ReviewedIdentity
	Description SessionDescription
}

type sessionRecord struct {
	identity     ReviewedIdentity
	podUID       types.UID
	idleExpires  time.Time
	absoluteEnds time.Time
}

type Store struct {
	mu          sync.Mutex
	clock       Clock
	tokenSource TokenSource
	sessions    map[[sha256.Size]byte]sessionRecord
}

func NewStore(clock Clock, tokenSource TokenSource) *Store {
	if clock == nil {
		clock = SystemClock{}
	}
	if tokenSource == nil {
		tokenSource = CryptoTokenSource{}
	}
	return &Store{
		clock:       clock,
		tokenSource: tokenSource,
		sessions:    make(map[[sha256.Size]byte]sessionRecord),
	}
}

func NewDefaultStore() *Store {
	return NewStore(SystemClock{}, CryptoTokenSource{})
}

func (store *Store) Create(
	identity ReviewedIdentity,
	podUID types.UID,
) (string, SessionDescription, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	now := store.clock.Now()
	store.pruneExpiredLocked(now)
	token, key, err := store.uniqueTokenLocked()
	if err != nil {
		return "", SessionDescription{}, err
	}
	now = store.clock.Now()
	store.pruneExpiredLocked(now)
	record := sessionRecord{
		identity:     cloneIdentity(identity),
		podUID:       podUID,
		idleExpires:  now.Add(sessionIdleLifetime),
		absoluteEnds: now.Add(sessionAbsoluteLifetime),
	}
	store.sessions[key] = record
	return token, describe(&record), nil
}

func (store *Store) Validate(token string, podUID types.UID) (ValidatedSession, error) {
	key, ok := tokenKey(token)
	if !ok {
		store.pruneExpired()
		return ValidatedSession{}, ErrInvalidSession
	}

	store.mu.Lock()
	defer store.mu.Unlock()
	now := store.clock.Now()
	record, exists := store.sessions[key]
	if !exists {
		store.pruneExpiredLocked(now)
		return ValidatedSession{}, ErrInvalidSession
	}
	if record.expired(now) {
		delete(store.sessions, key)
		store.pruneExpiredLocked(now)
		return ValidatedSession{}, ErrSessionExpired
	}
	if record.podUID != podUID {
		store.pruneExpiredLocked(now)
		return ValidatedSession{}, ErrInvalidSession
	}

	record.idleExpires = minTime(now.Add(sessionIdleLifetime), record.absoluteEnds)
	store.sessions[key] = record
	store.pruneExpiredLocked(now)
	return validated(&record), nil
}

func (store *Store) Rotate(
	token string,
	podUID types.UID,
) (string, SessionDescription, error) {
	oldKey, ok := tokenKey(token)
	if !ok {
		store.pruneExpired()
		return "", SessionDescription{}, ErrInvalidSession
	}

	store.mu.Lock()
	defer store.mu.Unlock()
	now := store.clock.Now()
	record, exists := store.sessions[oldKey]
	if !exists {
		store.pruneExpiredLocked(now)
		return "", SessionDescription{}, ErrInvalidSession
	}
	if record.expired(now) {
		delete(store.sessions, oldKey)
		store.pruneExpiredLocked(now)
		return "", SessionDescription{}, ErrSessionExpired
	}
	if record.podUID != podUID {
		store.pruneExpiredLocked(now)
		return "", SessionDescription{}, ErrInvalidSession
	}

	newToken, newKey, err := store.uniqueTokenLocked()
	if err != nil {
		return "", SessionDescription{}, err
	}
	now = store.clock.Now()
	if record.expired(now) {
		delete(store.sessions, oldKey)
		store.pruneExpiredLocked(now)
		return "", SessionDescription{}, ErrSessionExpired
	}
	record.idleExpires = minTime(now.Add(sessionIdleLifetime), record.absoluteEnds)
	store.sessions[newKey] = record
	delete(store.sessions, oldKey)
	store.pruneExpiredLocked(now)
	return newToken, describe(&record), nil
}

func (store *Store) Revoke(token string, podUID types.UID) error {
	key, ok := tokenKey(token)
	if !ok {
		store.pruneExpired()
		return ErrInvalidSession
	}

	store.mu.Lock()
	defer store.mu.Unlock()
	now := store.clock.Now()
	record, exists := store.sessions[key]
	if !exists {
		store.pruneExpiredLocked(now)
		return ErrInvalidSession
	}
	if record.expired(now) {
		delete(store.sessions, key)
		store.pruneExpiredLocked(now)
		return ErrSessionExpired
	}
	if record.podUID != podUID {
		store.pruneExpiredLocked(now)
		return ErrInvalidSession
	}
	delete(store.sessions, key)
	store.pruneExpiredLocked(now)
	return nil
}

func (store *Store) String() string {
	return "admin session store"
}

func (store *Store) GoString() string {
	return "admin.Store{}"
}

func (store *Store) uniqueTokenLocked() (
	encoded string,
	key [sha256.Size]byte,
	err error,
) {
	for range maxTokenAttempts {
		raw, err := store.tokenSource.Token()
		if err != nil {
			return "", [sha256.Size]byte{}, ErrTokenGeneration
		}
		key := sha256.Sum256(raw[:])
		if _, collision := store.sessions[key]; collision {
			continue
		}
		return base64.RawURLEncoding.EncodeToString(raw[:]), key, nil
	}
	return "", [sha256.Size]byte{}, ErrTokenGeneration
}

func (store *Store) pruneExpired() {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.pruneExpiredLocked(store.clock.Now())
}

func (store *Store) pruneExpiredLocked(now time.Time) {
	for key, record := range store.sessions {
		if record.expired(now) {
			delete(store.sessions, key)
		}
	}
}

func (record *sessionRecord) expired(now time.Time) bool {
	return !now.Before(record.idleExpires) || !now.Before(record.absoluteEnds)
}

func tokenKey(token string) ([sha256.Size]byte, bool) {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != sessionTokenBytes {
		return [sha256.Size]byte{}, false
	}
	return sha256.Sum256(raw), true
}

func validated(record *sessionRecord) ValidatedSession {
	return ValidatedSession{
		Identity:    cloneIdentity(record.identity),
		Description: describe(record),
	}
}

func describe(record *sessionRecord) SessionDescription {
	return SessionDescription{
		Subject:      record.identity.Username,
		AccessMode:   AccessMode,
		IdleExpires:  record.idleExpires,
		AbsoluteEnds: record.absoluteEnds,
		PodUID:       record.podUID,
	}
}

func cloneIdentity(identity ReviewedIdentity) ReviewedIdentity {
	cloned := ReviewedIdentity{
		Username: identity.Username,
		Groups:   append([]string(nil), identity.Groups...),
	}
	if identity.Extra != nil {
		cloned.Extra = make(map[string][]string, len(identity.Extra))
		for key, values := range identity.Extra {
			cloned.Extra[key] = append([]string(nil), values...)
		}
	}
	return cloned
}

func minTime(left, right time.Time) time.Time {
	if left.Before(right) {
		return left
	}
	return right
}
