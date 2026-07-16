package admin

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/types"
)

var sessionEpoch = time.Date(2026, time.July, 13, 12, 0, 0, 0, time.UTC)

type testClock struct {
	mu  sync.Mutex
	now time.Time
}

func (clock *testClock) Now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	return clock.now
}

func (clock *testClock) Set(now time.Time) {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	clock.now = now
}

type sequenceTokenSource struct {
	mu      sync.Mutex
	next    byte
	failure error
}

type observedClock struct {
	clock    *testClock
	observed chan struct{}
}

func (clock *observedClock) Now() time.Time {
	clock.observed <- struct{}{}
	return clock.clock.Now()
}

type gatedTokenSource struct {
	mu      sync.Mutex
	next    byte
	entered chan struct{}
	release chan struct{}
}

func (source *gatedTokenSource) Token() ([32]byte, error) {
	source.mu.Lock()
	source.next++
	next := source.next
	source.mu.Unlock()

	if next == 2 {
		close(source.entered)
		<-source.release
	}
	var token [32]byte
	token[0] = next
	return token, nil
}

func (source *sequenceTokenSource) Token() ([32]byte, error) {
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.failure != nil {
		return [32]byte{}, source.failure
	}
	source.next++
	var token [32]byte
	offset := byte(0)
	for index := 0; index < len(token); index++ {
		token[index] = source.next + offset
		offset++
	}
	return token, nil
}

func (source *sequenceTokenSource) Fail(err error) {
	source.mu.Lock()
	defer source.mu.Unlock()
	source.failure = err
}

func reviewedIdentity() ReviewedIdentity {
	return ReviewedIdentity{
		Username: "alice@example.com",
		Groups:   []string{"platform-admins", "system:authenticated"},
		Extra: map[string][]string{
			"authentication.kubernetes.io/credential-id": {"exec:omega"},
			"oidc.example.com/team":                      {"delivery", "platform"},
		},
	}
}

func newTestStore() (*Store, *testClock, *sequenceTokenSource) {
	clock := &testClock{now: sessionEpoch}
	tokens := &sequenceTokenSource{}
	return NewStore(clock, tokens), clock, tokens
}

func TestStoreCreateValidateAndDefensiveCopies(t *testing.T) {
	t.Parallel()

	store, clock, _ := newTestStore()
	identity := reviewedIdentity()
	token, description, err := store.Create(identity, types.UID("pod-uid-a"))
	require.NoError(t, err)

	assert.Equal(t, AccessMode, description.AccessMode)
	assert.Equal(t, "alice@example.com", description.Subject)
	assert.Equal(t, clock.Now().Add(10*time.Minute), description.IdleExpires)
	assert.Equal(t, clock.Now().Add(30*time.Minute), description.AbsoluteEnds)
	assert.Equal(t, types.UID("pod-uid-a"), description.PodUID)

	decoded, err := base64.RawURLEncoding.DecodeString(token)
	require.NoError(t, err)
	assert.Len(t, decoded, 32)
	assert.NotContains(t, token, "=")

	identity.Groups[0] = "mutated"
	identity.Extra["oidc.example.com/team"][0] = "mutated"
	identity.Extra["new"] = []string{"mutated"}

	clock.Set(sessionEpoch.Add(4 * time.Minute))
	validated, err := store.Validate(token, types.UID("pod-uid-a"))
	require.NoError(t, err)
	assert.Equal(t, reviewedIdentity(), validated.Identity())
	assert.Equal(t, sessionEpoch.Add(14*time.Minute), validated.Description().IdleExpires)

	validatedIdentity := validated.Identity()
	validatedIdentity.Groups[0] = "caller-mutated"
	validatedIdentity.Extra["oidc.example.com/team"][0] = "caller-mutated"
	again, err := store.Validate(token, types.UID("pod-uid-a"))
	require.NoError(t, err)
	assert.Equal(t, reviewedIdentity(), again.Identity())
}

func TestStoreDefaultSourceEmitsUniqueCryptographicWidthTokens(t *testing.T) {
	t.Parallel()

	store := NewDefaultStore()
	first, _, err := store.Create(reviewedIdentity(), types.UID("pod-uid-a"))
	require.NoError(t, err)
	second, _, err := store.Create(reviewedIdentity(), types.UID("pod-uid-a"))
	require.NoError(t, err)
	assert.NotEqual(t, first, second)

	for _, token := range []string{first, second} {
		decoded, decodeErr := base64.RawURLEncoding.DecodeString(token)
		require.NoError(t, decodeErr)
		assert.Len(t, decoded, 32)
	}
}

func TestStoreLifetimeTable(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		validateAt  []time.Duration
		finalAt     time.Duration
		wantIdleEnd time.Duration
		wantError   error
	}{
		{
			name:      "idle expiry is exclusive at ten minutes",
			finalAt:   10 * time.Minute,
			wantError: ErrSessionExpired,
		},
		{
			name:        "validation extends idle lifetime",
			validateAt:  []time.Duration{9 * time.Minute},
			finalAt:     18 * time.Minute,
			wantIdleEnd: 28 * time.Minute,
		},
		{
			name:        "idle extension is capped by absolute lifetime",
			validateAt:  []time.Duration{9 * time.Minute, 18 * time.Minute, 27 * time.Minute},
			finalAt:     29 * time.Minute,
			wantIdleEnd: 30 * time.Minute,
		},
		{
			name:       "validation never crosses absolute lifetime",
			validateAt: []time.Duration{9 * time.Minute, 18 * time.Minute, 27 * time.Minute},
			finalAt:    30 * time.Minute,
			wantError:  ErrSessionExpired,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			store, clock, _ := newTestStore()
			token, _, err := store.Create(reviewedIdentity(), types.UID("pod-uid-a"))
			require.NoError(t, err)

			for _, offset := range test.validateAt {
				clock.Set(sessionEpoch.Add(offset))
				_, err = store.Validate(token, types.UID("pod-uid-a"))
				require.NoError(t, err)
			}

			clock.Set(sessionEpoch.Add(test.finalAt))
			validated, err := store.Validate(token, types.UID("pod-uid-a"))
			if test.wantError != nil {
				require.ErrorIs(t, err, test.wantError)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, sessionEpoch.Add(test.wantIdleEnd), validated.Description().IdleExpires)
			assert.Equal(t, sessionEpoch.Add(30*time.Minute), validated.Description().AbsoluteEnds)
		})
	}
}

func TestStoreRejectsWrongTokenAndPodWithoutInvalidatingSession(t *testing.T) {
	t.Parallel()

	store, _, _ := newTestStore()
	token, _, err := store.Create(reviewedIdentity(), types.UID("pod-uid-a"))
	require.NoError(t, err)

	_, err = store.Validate("not-a-session-token", types.UID("pod-uid-a"))
	require.ErrorIs(t, err, ErrInvalidSession)
	assert.NotContains(t, err.Error(), "not-a-session-token")

	_, err = store.Validate(token, types.UID("pod-uid-b"))
	require.ErrorIs(t, err, ErrInvalidSession)
	assert.NotContains(t, err.Error(), token)

	_, err = store.Validate(token, types.UID("pod-uid-a"))
	require.NoError(t, err)
}

func TestStoreValidateUsesTimeObservedAfterAcquiringLock(t *testing.T) {
	t.Parallel()

	baseClock := &testClock{now: sessionEpoch}
	clock := &observedClock{
		clock:    baseClock,
		observed: make(chan struct{}, 4),
	}
	store := NewStore(clock, &sequenceTokenSource{})
	token, _, err := store.Create(reviewedIdentity(), types.UID("pod-uid-a"))
	require.NoError(t, err)
	for len(clock.observed) > 0 {
		<-clock.observed
	}

	baseClock.Set(sessionEpoch.Add(9 * time.Minute))
	store.mu.Lock()
	started := make(chan struct{})
	validation := make(chan error, 1)
	go func() {
		close(started)
		_, validateErr := store.Validate(token, types.UID("pod-uid-a"))
		validation <- validateErr
	}()
	<-started

	select {
	case <-clock.observed:
		// A stale implementation reads the clock before it reaches the lock.
	case <-time.After(100 * time.Millisecond):
	}
	baseClock.Set(sessionEpoch.Add(11 * time.Minute))
	store.mu.Unlock()

	require.ErrorIs(t, <-validation, ErrSessionExpired)
}

func TestStoreRotateRechecksExpiryAfterTokenGeneration(t *testing.T) {
	t.Parallel()

	clock := &testClock{now: sessionEpoch}
	tokens := &gatedTokenSource{
		entered: make(chan struct{}),
		release: make(chan struct{}),
	}
	store := NewStore(clock, tokens)
	token, _, err := store.Create(reviewedIdentity(), types.UID("pod-uid-a"))
	require.NoError(t, err)

	clock.Set(sessionEpoch.Add(9 * time.Minute))
	rotation := make(chan error, 1)
	go func() {
		_, _, rotateErr := store.Rotate(token, types.UID("pod-uid-a"))
		rotation <- rotateErr
	}()
	<-tokens.entered
	clock.Set(sessionEpoch.Add(11 * time.Minute))
	close(tokens.release)

	require.ErrorIs(t, <-rotation, ErrSessionExpired)
	_, err = store.Validate(token, types.UID("pod-uid-a"))
	require.ErrorIs(t, err, ErrInvalidSession)
}

func TestStoreRotateIsAtomicAndPreservesAbsoluteLifetime(t *testing.T) {
	t.Parallel()

	store, clock, tokens := newTestStore()
	oldToken, _, err := store.Create(reviewedIdentity(), types.UID("pod-uid-a"))
	require.NoError(t, err)

	clock.Set(sessionEpoch.Add(8 * time.Minute))
	newToken, description, err := store.Rotate(oldToken, types.UID("pod-uid-a"))
	require.NoError(t, err)
	assert.NotEqual(t, oldToken, newToken)
	assert.Equal(t, sessionEpoch.Add(18*time.Minute), description.IdleExpires)
	assert.Equal(t, sessionEpoch.Add(30*time.Minute), description.AbsoluteEnds)

	_, err = store.Validate(oldToken, types.UID("pod-uid-a"))
	require.ErrorIs(t, err, ErrInvalidSession)
	_, err = store.Validate(newToken, types.UID("pod-uid-a"))
	require.NoError(t, err)

	tokens.Fail(errors.New("entropy unavailable"))
	_, _, err = store.Rotate(newToken, types.UID("pod-uid-a"))
	require.ErrorIs(t, err, ErrTokenGeneration)
	assert.NotContains(t, err.Error(), newToken)
	_, err = store.Validate(newToken, types.UID("pod-uid-a"))
	require.NoError(t, err, "a failed rotation must retain the authenticated token")
}

func TestStoreRevokeAuthenticatesAndRejectsExpiredSessions(t *testing.T) {
	t.Parallel()

	store, clock, _ := newTestStore()
	token, _, err := store.Create(reviewedIdentity(), types.UID("pod-uid-a"))
	require.NoError(t, err)

	require.ErrorIs(t, store.Revoke(token, types.UID("pod-uid-b")), ErrInvalidSession)
	_, err = store.Validate(token, types.UID("pod-uid-a"))
	require.NoError(t, err)

	require.NoError(t, store.Revoke(token, types.UID("pod-uid-a")))
	_, err = store.Validate(token, types.UID("pod-uid-a"))
	require.ErrorIs(t, err, ErrInvalidSession)
	require.ErrorIs(t, store.Revoke(token, types.UID("pod-uid-a")), ErrInvalidSession)

	expiringToken, _, err := store.Create(reviewedIdentity(), types.UID("pod-uid-a"))
	require.NoError(t, err)
	clock.Set(sessionEpoch.Add(11 * time.Minute))
	err = store.Revoke(expiringToken, types.UID("pod-uid-a"))
	require.ErrorIs(t, err, ErrSessionExpired)
	assert.NotContains(t, err.Error(), expiringToken)
	require.ErrorIs(t, store.Revoke(expiringToken, types.UID("pod-uid-a")), ErrInvalidSession)
}

func TestStorePrunesExpiredRecordsDuringCreate(t *testing.T) {
	t.Parallel()

	store, clock, _ := newTestStore()
	expiredToken, _, err := store.Create(reviewedIdentity(), types.UID("pod-uid-a"))
	require.NoError(t, err)
	clock.Set(sessionEpoch.Add(11 * time.Minute))
	currentToken, _, err := store.Create(reviewedIdentity(), types.UID("pod-uid-a"))
	require.NoError(t, err)

	store.mu.Lock()
	assert.Len(t, store.sessions, 1)
	store.mu.Unlock()
	_, err = store.Validate(expiredToken, types.UID("pod-uid-a"))
	require.ErrorIs(t, err, ErrInvalidSession)
	_, err = store.Validate(currentToken, types.UID("pod-uid-a"))
	require.NoError(t, err)
}

func TestStoreDescriptionsErrorsAndFormattingNeverExposeTokens(t *testing.T) {
	t.Parallel()

	store, _, _ := newTestStore()
	token, description, err := store.Create(reviewedIdentity(), types.UID("pod-uid-a"))
	require.NoError(t, err)
	validated, err := store.Validate(token, types.UID("pod-uid-a"))
	require.NoError(t, err)

	formatted := make([]string, 0, 6)
	formatted = append(formatted,
		fmt.Sprintf("%v", description),
		fmt.Sprintf("%+v", description),
		fmt.Sprintf("%#v", description),
		fmt.Sprintf("%v", validated),
		fmt.Sprintf("%+v", store),
	)
	encoded, err := json.Marshal(description)
	require.NoError(t, err)
	formatted = append(formatted, string(encoded))
	for _, value := range formatted {
		assert.NotContains(t, value, token)
	}

	_, err = store.Validate(token+"secret-suffix", types.UID("pod-uid-a"))
	require.Error(t, err)
	assert.False(t, strings.Contains(err.Error(), token))
}

func TestStoreConcurrentValidateRotateAndRevoke(t *testing.T) {
	t.Parallel()

	store, _, _ := newTestStore()
	token, _, err := store.Create(reviewedIdentity(), types.UID("pod-uid-a"))
	require.NoError(t, err)

	var wait sync.WaitGroup
	start := make(chan struct{})
	for worker := 0; worker < 24; worker++ {
		wait.Add(1)
		go func(worker int) {
			defer wait.Done()
			<-start
			switch worker % 3 {
			case 0:
				_, validateErr := store.Validate(token, types.UID("pod-uid-a"))
				assertConcurrentStoreError(t, validateErr)
			case 1:
				_, _, rotateErr := store.Rotate(token, types.UID("pod-uid-a"))
				assertConcurrentStoreError(t, rotateErr)
			case 2:
				revokeErr := store.Revoke(token, types.UID("pod-uid-a"))
				assertConcurrentStoreError(t, revokeErr)
			}
		}(worker)
	}
	close(start)
	wait.Wait()
}

func assertConcurrentStoreError(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		return
	}
	assert.ErrorIs(t, err, ErrInvalidSession)
}
