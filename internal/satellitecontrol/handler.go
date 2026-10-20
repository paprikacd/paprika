// Package satellitecontrol accepts authenticated, ordered cluster observations.
// Baselines live in Cluster status so all API replicas share one sequence fence.
package satellitecontrol

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/util/retry"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	clusters "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	"github.com/benebsworth/paprika/internal/metrics"
	"github.com/benebsworth/paprika/internal/satellite"
)

// #nosec G101 -- this is a Kubernetes label key, not a credential.
const CredentialLabel = "paprika.io/satellite-cluster"

type Handler struct{ client client.Client }

func NewHandler(c client.Client) *Handler { return &Handler{client: c} }

type reportError struct {
	code    int
	message string
}

func (e *reportError) Error() string        { return e.message }
func refuse(code int, message string) error { return &reportError{code, message} }

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	outcome := metrics.SatelliteReportRejected
	defer func(ctx context.Context) {
		attrs := metrics.SatelliteReportAttributes(metrics.SatelliteTransportPost, outcome)
		metrics.SatelliteReports.Add(ctx, 1, attrs)
		metrics.SatelliteReportDuration.Record(ctx, time.Since(started).Seconds(), attrs)
	}(r.Context())
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if h.client == nil {
		http.Error(w, "satellite reporting unavailable", http.StatusServiceUnavailable)
		return
	}
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") || strings.TrimSpace(strings.TrimPrefix(auth, "Bearer ")) == "" {
		http.Error(w, "satellite credential required", http.StatusUnauthorized)
		return
	}
	token := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
	body, err := readReport(w, r)
	if err != nil {
		http.Error(w, "invalid or oversized report", http.StatusBadRequest)
		return
	}
	report, err := decodeReport(body)
	if err != nil {
		http.Error(w, "invalid satellite report", http.StatusBadRequest)
		return
	}
	digestBytes := sha256.Sum256(body)
	digest := hex.EncodeToString(digestBytes[:])
	err = h.accept(r.Context(), report, token, digest)
	if err != nil {
		var refusal *reportError
		if errors.As(err, &refusal) {
			http.Error(w, refusal.message, refusal.code)
			return
		}
		log.FromContext(r.Context()).Error(err, "Satellite report persistence failed")
		http.Error(w, "satellite report persistence failed", http.StatusServiceUnavailable)
		return
	}
	outcome = metrics.SatelliteReportAccepted
	metrics.SatelliteReportBytes.Record(r.Context(), int64(len(body)))
	w.WriteHeader(http.StatusNoContent)
}

func decodeReport(body []byte) (*satellite.Report, error) {
	var report satellite.Report
	decoder := json.NewDecoder(bytes.NewReader(body))
	// Unknown fields are tolerated on purpose. A satellite is deployed
	// independently of the control plane it reports to, so a newer satellite
	// must not have its reports rejected in their entirety because it added a
	// field. Every field the receiver acts on is validated by validateReport;
	// the fields it does not know about are ignored, not trusted.
	if err := decoder.Decode(&report); err != nil {
		return nil, fmt.Errorf("decode satellite report: %w", err)
	}
	if err := validateReport(&report); err != nil {
		return nil, err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return nil, errors.New("unexpected trailing report data")
	}
	return &report, nil
}

func readReport(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	r.Body = http.MaxBytesReader(w, r.Body, satellite.MaxReportBytes)
	defer func() { _ = r.Body.Close() }() //nolint:errcheck // closing a consumed request body is best-effort.
	var reader io.Reader = r.Body
	switch r.Header.Get("Content-Encoding") {
	case "", "identity":
	case "gzip":
		gz, err := gzip.NewReader(r.Body)
		if err != nil {
			return nil, fmt.Errorf("open report compression: %w", err)
		}
		defer func() { _ = gz.Close() }() //nolint:errcheck // read-only decompression has no buffered output to flush.
		reader = gz
	default:
		return nil, errors.New("unsupported content encoding")
	}
	body, err := io.ReadAll(io.LimitReader(reader, satellite.MaxReportBytes+1))
	if len(body) > satellite.MaxReportBytes {
		return nil, errors.New("report too large")
	}
	if err != nil {
		return nil, fmt.Errorf("read report body: %w", err)
	}
	return body, nil
}

// Authenticate resolves the registration a satellite credential authorizes.
//
// It refuses a missing registration rather than enrolling one: enrolment needs a
// full snapshot to seed a baseline, which only a report can supply, so a stream
// handshake that created a Cluster would leave a registration with no state and
// no fence.
func (h *Handler) Authenticate(ctx context.Context, namespace, name, token string) (*clusters.Cluster, error) {
	if h.client == nil {
		return nil, refuse(http.StatusServiceUnavailable, "satellite reporting unavailable")
	}
	var cluster clusters.Cluster
	err := h.client.Get(ctx, client.ObjectKey{Namespace: namespace, Name: name}, &cluster)
	if apierrors.IsNotFound(err) {
		return nil, refuse(http.StatusUnauthorized, "satellite credential refused")
	}
	if err != nil {
		return nil, fmt.Errorf("read satellite registration: %w", err)
	}
	if !acceptsReports(&cluster) {
		return nil, refuse(http.StatusForbidden, "cluster does not accept satellite reports")
	}
	if err := h.authorize(ctx, &cluster, token); err != nil {
		return nil, err
	}
	return &cluster, nil
}

func (h *Handler) authorize(ctx context.Context, cluster *clusters.Cluster, token string) error {
	ref := clusters.SecretRef{Name: cluster.Name + "-satellite-token", Key: "token"}
	if cluster.Spec.Satellite != nil {
		ref = cluster.Spec.Satellite.TokenSecretRef
	}
	if ref.Namespace != "" && ref.Namespace != cluster.Namespace {
		return refuse(http.StatusForbidden, "satellite credential namespace mismatch")
	}
	var secret corev1.Secret
	if err := h.client.Get(ctx, client.ObjectKey{Namespace: cluster.Namespace, Name: ref.Name}, &secret); err != nil {
		if apierrors.IsNotFound(err) {
			return refuse(http.StatusUnauthorized, "satellite credential refused")
		}
		return fmt.Errorf("read satellite credential: %w", err)
	}
	if secret.Labels[CredentialLabel] != cluster.Name {
		return refuse(http.StatusUnauthorized, "satellite credential refused")
	}
	key := ref.Key
	if key == "" {
		key = "token"
	}
	want := []byte(strings.TrimSpace(string(secret.Data[key])))
	if len(want) < 32 {
		return refuse(http.StatusUnauthorized, "satellite credential refused")
	}
	wantHash, gotHash := sha256.Sum256(want), sha256.Sum256([]byte(token))
	if subtle.ConstantTimeCompare(wantHash[:], gotHash[:]) != 1 {
		return refuse(http.StatusUnauthorized, "satellite credential refused")
	}
	return nil
}

func (h *Handler) accept(ctx context.Context, report *satellite.Report, token, digest string) error {
	// Retry only optimistic-concurrency conflicts. A report is not acknowledged
	// until its durable baseline is written; every retry reads current status.
	err := retry.OnError(retry.DefaultRetry, func(err error) bool {
		return apierrors.IsConflict(err) || apierrors.IsAlreadyExists(err)
	}, func() error { return h.acceptOnce(ctx, report, token, digest) })
	if err != nil {
		return fmt.Errorf("accept satellite report: %w", err)
	}
	return nil
}

func (h *Handler) acceptOnce(ctx context.Context, report *satellite.Report, token, digest string) error {
	cluster, err := h.authorizedCluster(ctx, report, token)
	if err != nil {
		return err
	}
	duplicate, err := validateBaseline(cluster.Status.Satellite, report, digest)
	if err != nil || duplicate {
		return err
	}
	state, err := buildBaseline(cluster.Status.Satellite, report, digest)
	if err != nil {
		return err
	}
	// Patch only the fields this handler owns rather than replacing the whole
	// status. The cluster controller writes inventory and health on its own
	// schedule, and a full update makes every overlap a conflict: the loser
	// retries with backoff, which is where the multi-second report latencies
	// come from once a registration carries a large application list.
	base := cluster.DeepCopy()
	applyReportStatus(cluster, report, state)
	if err := h.client.Status().Patch(ctx, cluster, client.MergeFrom(base)); err != nil {
		return fmt.Errorf("persist satellite state: %w", err)
	}
	return nil
}
