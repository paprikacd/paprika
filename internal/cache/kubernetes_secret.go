package cache

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/client-go/util/retry"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

const (
	secretResourceKey      = "resource"
	secretCanaryKey        = "canary"
	secretEntryPrefix      = "entry."
	secretCacheLimit       = 700 * 1024
	secretEntryLimit       = 2048
	secretValueLimit       = 16 * 1024
	secretKeyLimit         = 2048
	secretTemporaryLimit   = 128 * 1024
	secretTemporaryEntries = 256
)

var secretCacheBackoff = wait.Backoff{Steps: 10, Duration: 5 * time.Millisecond, Factor: 1.5, Jitter: 0.1}

type secretObjects interface {
	Get(context.Context, client.ObjectKey, client.Object, ...client.GetOption) error
	Update(context.Context, client.Object, ...client.UpdateOption) error
}

// secretCache holds short-lived OAuth state and rotating grants in one
// pre-created Secret. Keys are hashed and records are encrypted using a key
// derived from the existing token-signing secret. Kubernetes resource-version
// updates make consuming a record atomic across gateway instances.
type secretCache struct {
	objects  secretObjects
	key      client.ObjectKey
	resource string
	aead     cipher.AEAD
	now      func() time.Time
}

type secretCacheRecord struct {
	Key   string `json:"key"`
	Value []byte `json:"value"`
}

// NewKubernetesSecretCache verifies a resource-bound, pre-created Secret and
// initializes or verifies its encryption canary. It never falls back to memory.
// The caller must use a direct API client, not an informer-backed reader.
func NewKubernetesSecretCache(ctx context.Context, objects secretObjects, namespace, name, resource string, signingSecret []byte) (*Cache, error) {
	if objects == nil || namespace == "" || name == "" || resource == "" || len(signingSecret) == 0 {
		return nil, errors.New("OAuth session storage requires a client, namespace, Secret, resource and signing secret")
	}
	key, err := hkdf.Key(sha256.New, signingSecret, []byte(resource), "paprika/oauth-session-storage/v1", 32)
	if err != nil {
		return nil, fmt.Errorf("derive OAuth session encryption key: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("initialize OAuth session encryption: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("initialize OAuth session encryption: %w", err)
	}
	c := &secretCache{objects: objects, key: client.ObjectKey{Namespace: namespace, Name: name}, resource: resource, aead: aead, now: time.Now}
	if err := c.initialize(ctx); err != nil {
		return nil, fmt.Errorf("initialize OAuth session storage: %w", err)
	}
	return &Cache{cacheImpl: c}, nil
}

func (c *secretCache) read(ctx context.Context) (*corev1.Secret, error) {
	var secret corev1.Secret
	if err := c.objects.Get(ctx, c.key, &secret); err != nil {
		return nil, fmt.Errorf("read OAuth session Secret: %w", err)
	}
	if string(secret.Data[secretResourceKey]) != c.resource {
		return nil, errors.New("OAuth session Secret is bound to a different resource")
	}
	return &secret, nil
}

func (c *secretCache) initialize(ctx context.Context) error {
	return retrySecretWrite(func() error {
		secret, err := c.read(ctx)
		if err != nil {
			return err
		}
		if encoded, ok := secret.Data[secretCanaryKey]; ok {
			record, openErr := c.open(secretCanaryKey, encoded)
			if openErr != nil || record.Key != secretCanaryKey || string(record.Value) != "paprika-oauth-session-v1" {
				return errors.New("OAuth session Secret cannot be decrypted with the configured signing secret")
			}
			// Check write permission as well as readability without changing the
			// resource. Otherwise the server would start but strand new grants.
			return c.update(ctx, secret, client.DryRunAll)
		}
		for key := range secret.Data {
			if strings.HasPrefix(key, secretEntryPrefix) {
				return errors.New("OAuth session Secret has records but no encryption canary")
			}
		}
		encoded, err := c.seal(secretCanaryKey, secretCacheRecord{Key: secretCanaryKey, Value: []byte("paprika-oauth-session-v1")}, time.Time{})
		if err != nil {
			return err
		}
		secret.Data[secretCanaryKey] = encoded
		return c.update(ctx, secret)
	})
}

func retrySecretWrite(fn func() error) error {
	if err := retry.RetryOnConflict(secretCacheBackoff, fn); err != nil {
		return fmt.Errorf("update OAuth session storage: %w", err)
	}
	return nil
}

func (c *secretCache) update(ctx context.Context, secret *corev1.Secret, opts ...client.UpdateOption) error {
	if err := c.objects.Update(ctx, secret, opts...); err != nil {
		return fmt.Errorf("update OAuth session Secret: %w", err)
	}
	return nil
}

func secretEntryKey(key string) string {
	sum := sha256.Sum256([]byte(key))
	class := "temporary."
	if strings.HasPrefix(key, "mcp:refresh:") {
		class = "refresh."
	}
	return secretEntryPrefix + class + hex.EncodeToString(sum[:])
}

// The expiry is authenticated as additional data, so it cannot be extended
// without knowing the encryption key. It is visible for bounded expiry cleanup.
func (c *secretCache) seal(name string, record secretCacheRecord, expiry time.Time) ([]byte, error) {
	plain, err := json.Marshal(record)
	if err != nil {
		return nil, fmt.Errorf("encode OAuth session record: %w", err)
	}
	header := make([]byte, 9, 9+c.aead.NonceSize()+len(plain)+c.aead.Overhead())
	header[0] = 1
	if !expiry.IsZero() {
		if expiry.Before(time.Unix(0, 1)) || expiry.After(time.Unix(0, math.MaxInt64)) {
			return nil, errors.New("OAuth session expiry is out of range")
		}
		binary.BigEndian.PutUint64(header[1:], uint64(expiry.UnixNano())) // #nosec G115 -- expiry is checked positive and bounded.
	}
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("generate OAuth session nonce: %w", err)
	}
	aad := append([]byte(c.resource+"\x00"+name+"\x00"), header...)
	sealed := c.aead.Seal(nil, nonce, plain, aad)
	return append(append(header, nonce...), sealed...), nil
}

func (c *secretCache) open(name string, encoded []byte) (secretCacheRecord, error) {
	var record secretCacheRecord
	if len(encoded) < 9+c.aead.NonceSize()+c.aead.Overhead() || encoded[0] != 1 {
		return record, errors.New("invalid encrypted OAuth session record")
	}
	header := encoded[:9]
	aad := append([]byte(c.resource+"\x00"+name+"\x00"), header...)
	nonceEnd := 9 + c.aead.NonceSize()
	plain, err := c.aead.Open(nil, encoded[9:nonceEnd], encoded[nonceEnd:], aad)
	if err != nil {
		return record, errors.New("cannot decrypt OAuth session record")
	}
	if err := json.Unmarshal(plain, &record); err != nil {
		return record, errors.New("invalid OAuth session record")
	}
	return record, nil
}

func (c *secretCache) expired(encoded []byte) bool {
	if len(encoded) < 9 || encoded[0] != 1 {
		return false // preserve malformed data for explicit error handling
	}
	nanos := binary.BigEndian.Uint64(encoded[1:9])
	now := c.now().UnixNano()
	return nanos != 0 && now >= 0 && uint64(now) >= nanos // #nosec G115 -- now is checked nonnegative.
}

func (c *secretCache) value(secret *corev1.Secret, key string) (value []byte, present bool, err error) {
	name := secretEntryKey(key)
	encoded, ok := secret.Data[name]
	if !ok || c.expired(encoded) {
		return nil, false, nil
	}
	record, err := c.open(name, encoded)
	if err != nil || record.Key != key {
		return nil, false, errors.New("invalid OAuth session record")
	}
	return record.Value, true, nil
}

func (c *secretCache) Get(ctx context.Context, key string) ([]byte, error) {
	secret, err := c.read(ctx)
	if err != nil {
		return nil, err
	}
	value, _, err := c.value(secret, key)
	return value, err
}

func (c *secretCache) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	name, encoded, err := c.prepareRecord(key, value, ttl)
	if err != nil {
		return err
	}
	return retrySecretWrite(func() error {
		secret, readErr := c.read(ctx)
		if readErr != nil {
			return readErr
		}
		for k, v := range secret.Data {
			if strings.HasPrefix(k, secretEntryPrefix) && c.expired(v) {
				delete(secret.Data, k)
			}
		}
		secret.Data[name] = encoded
		if capacityErr := checkSecretCapacity(secret); capacityErr != nil {
			return capacityErr
		}
		return c.update(ctx, secret)
	})
}

func (c *secretCache) prepareRecord(key string, value []byte, ttl time.Duration) (name string, encoded []byte, err error) {
	if key == "" || len(key) > secretKeyLimit || len(value) > secretValueLimit || ttl < 0 {
		return "", nil, errors.New("OAuth session record exceeds storage limits")
	}
	var expiry time.Time
	if ttl > 0 {
		expiry = c.now().Add(ttl)
	}
	name = secretEntryKey(key)
	encoded, err = c.seal(name, secretCacheRecord{Key: key, Value: value}, expiry)
	if err != nil {
		return "", nil, err
	}
	return name, encoded, nil
}

func checkSecretCapacity(secret *corev1.Secret) error {
	count, size, temporarySize, temporaryCount := 0, 0, 0, 0
	for k, v := range secret.Data {
		size += len(k) + len(v)
		if strings.HasPrefix(k, secretEntryPrefix) {
			count++
		}
		if strings.HasPrefix(k, secretEntryPrefix+"temporary.") {
			temporarySize += len(k) + len(v)
			temporaryCount++
		}
	}
	if count > secretEntryLimit || size > secretCacheLimit || temporarySize > secretTemporaryLimit || temporaryCount > secretTemporaryEntries {
		return errors.New("OAuth session storage is full")
	}
	return nil
}

func (c *secretCache) GetDel(ctx context.Context, key string) ([]byte, error) {
	var result []byte
	err := retrySecretWrite(func() error {
		secret, readErr := c.read(ctx)
		if readErr != nil {
			return readErr
		}
		value, present, valueErr := c.value(secret, key)
		if valueErr != nil || !present {
			return valueErr
		}
		delete(secret.Data, secretEntryKey(key))
		if updateErr := c.update(ctx, secret); updateErr != nil {
			return updateErr
		}
		result = value
		return nil
	})
	return result, err
}

// Replace consumes the predecessor and stores its successor in the same
// resource-version update. Concurrent rotations can have only one winner.
func (c *secretCache) Replace(ctx context.Context, oldKey string, expected []byte, newKey string, value []byte, ttl time.Duration) (bool, error) {
	if oldKey == newKey {
		return false, errors.New("invalid OAuth session rotation")
	}
	newName, sealed, err := c.prepareRecord(newKey, value, ttl)
	if err != nil {
		return false, err
	}
	replaced := false
	err = retrySecretWrite(func() error {
		var replaceErr error
		replaced, replaceErr = c.replaceOnce(ctx, oldKey, expected, newName, sealed)
		return replaceErr
	})
	return replaced, err
}

func (c *secretCache) replaceOnce(ctx context.Context, oldKey string, expected []byte, newName string, sealed []byte) (bool, error) {
	secret, err := c.read(ctx)
	if err != nil {
		return false, err
	}
	previous, present, err := c.value(secret, oldKey)
	if err != nil || !present {
		return false, err
	}
	if !bytes.Equal(previous, expected) {
		return false, nil
	}
	if _, exists := secret.Data[newName]; exists {
		return false, errors.New("OAuth session successor already exists")
	}
	delete(secret.Data, secretEntryKey(oldKey))
	secret.Data[newName] = sealed
	if err := checkSecretCapacity(secret); err != nil {
		return false, err
	}
	if err := c.update(ctx, secret); err != nil {
		return false, err
	}
	return true, nil
}

func (c *secretCache) Delete(ctx context.Context, key string) error {
	_, err := c.GetDel(ctx, key)
	return err
}

func (c *secretCache) DeleteByPrefix(ctx context.Context, prefix string) error {
	return retrySecretWrite(func() error {
		secret, err := c.read(ctx)
		if err != nil {
			return err
		}
		changed := false
		for name, encoded := range secret.Data {
			if !strings.HasPrefix(name, secretEntryPrefix) {
				continue
			}
			if c.expired(encoded) {
				delete(secret.Data, name)
				changed = true
				continue
			}
			record, openErr := c.open(name, encoded)
			if openErr != nil || secretEntryKey(record.Key) != name {
				return errors.New("invalid OAuth session record")
			}
			if strings.HasPrefix(record.Key, prefix) {
				delete(secret.Data, name)
				changed = true
			}
		}
		if !changed {
			return nil
		}
		return c.update(ctx, secret)
	})
}

func (c *secretCache) Ping(ctx context.Context) error { return c.initialize(ctx) }
func (c *secretCache) Close() error                   { return nil }
