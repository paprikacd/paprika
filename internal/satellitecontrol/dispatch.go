package satellitecontrol

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"google.golang.org/protobuf/encoding/protojson"
	"k8s.io/apimachinery/pkg/types"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

// Split mode puts the satellite links in the API server's process and the
// release reconciler in another pod. The reconciler still needs to ask "is
// this cluster's link up" and to send it a task, so the API server exposes
// those two questions on an internal listener that the public route does not
// carry.
//
// The listener is a separate address rather than a path on the API mux: an
// apply path reachable from the internet would let anyone holding the port push
// manifests into satellites. It is bound in-cluster only and requires a bearer
// token; an unset token refuses every request rather than serving without one.

// InternalDispatchPrefix is where the internal listener mounts its routes.
const InternalDispatchPrefix = "/internal/satellite/"

// InternalDispatchTokenHeader is the bearer token header both halves use.
const InternalDispatchTokenHeader = "Authorization"

// connectedTTL bounds how long a link snapshot is reused. Connected is asked
// during target resolution on every apply, and a round trip per reconcile would
// put the API server in the path of work that usually does not need it.
const connectedTTL = 2 * time.Second

// dispatchHTTPClient is shared so connections to the API server are pooled.
//
// The internal API is request/response, not a stream, so plain HTTP/1.1 is
// enough; h2c is for the link itself.
var dispatchHTTPClient = &http.Client{
	Timeout: DefaultTaskTimeout + 5*time.Second,
	Transport: &http.Transport{
		MaxIdleConns:        16,
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     90 * time.Second,
	},
}

// RemoteDispatcher is the controller's client for an API server that owns the
// links. It answers the same two questions as Hub, for split mode.
type RemoteDispatcher struct {
	addr  string
	token string
	now   func() time.Time

	mu        sync.Mutex
	links     map[types.NamespacedName]struct{}
	expiresAt time.Time
}

// NewRemoteDispatcher points a dispatcher at an API server's internal listener.
func NewRemoteDispatcher(addr, token string) *RemoteDispatcher {
	return &RemoteDispatcher{
		addr:  strings.TrimSuffix(addr, "/"),
		token: token,
		now:   time.Now,
	}
}

// Connected reports whether the cluster currently holds a link. A failed
// snapshot reads as "not connected": the caller then either falls back to the
// documented agent endpoint or refuses the target, which is the same answer a
// missing link produces.
func (d *RemoteDispatcher) Connected(key types.NamespacedName) bool {
	d.mu.Lock()
	fresh := !d.expiresAt.IsZero() && d.now().Before(d.expiresAt)
	links := d.links
	d.mu.Unlock()
	if !fresh {
		snapshot, err := d.snapshotLinks()
		if err != nil {
			return false
		}
		links = snapshot
	}
	_, ok := links[key]
	return ok
}

func (d *RemoteDispatcher) snapshotLinks() (map[types.NamespacedName]struct{}, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.addr+InternalDispatchPrefix+"links", http.NoBody)
	if err != nil {
		return nil, fmt.Errorf("build satellite links request: %w", err)
	}
	d.authorize(req)
	resp, err := dispatchHTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("read satellite links: %w", err)
	}
	defer closeBody(resp)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("read satellite links: %s", resp.Status)
	}
	var payload linksResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode satellite links: %w", err)
	}
	links := make(map[types.NamespacedName]struct{}, len(payload.Links))
	for _, link := range payload.Links {
		links[types.NamespacedName{Namespace: link.Namespace, Name: link.Name}] = struct{}{}
	}

	d.mu.Lock()
	d.links = links
	d.expiresAt = d.now().Add(connectedTTL)
	d.mu.Unlock()
	return links, nil
}

// Dispatch sends one task down the cluster's link and waits for its result.
func (d *RemoteDispatcher) Dispatch(ctx context.Context, key types.NamespacedName, task *paprikav1.SatelliteTask) (*paprikav1.SatelliteTaskResult, error) {
	encodedTask, err := protojson.Marshal(task)
	if err != nil {
		return nil, fmt.Errorf("encode satellite task: %w", err)
	}
	body, err := json.Marshal(dispatchRequest{
		Namespace: key.Namespace,
		Name:      key.Name,
		Task:      encodedTask,
	})
	if err != nil {
		return nil, fmt.Errorf("encode dispatch request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.addr+InternalDispatchPrefix+"dispatch", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build dispatch request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	d.authorize(req)

	resp, err := dispatchHTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("dispatch satellite task: %w", err)
	}
	defer closeBody(resp)

	payload, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, fmt.Errorf("read dispatch response: %w", err)
	}
	if resp.StatusCode == http.StatusNotFound {
		// The dispatcher reports an unattached link this way; it is the same
		// condition as a nil local link, so callers see the same sentinel.
		return nil, fmt.Errorf("%w: %s", ErrSatelliteOffline, key.String())
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("dispatch satellite task: %s: %s", resp.Status, strings.TrimSpace(string(payload)))
	}

	var envelope dispatchResponse
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return nil, fmt.Errorf("decode dispatch response: %w", err)
	}
	var result paprikav1.SatelliteTaskResult
	if err := protojson.Unmarshal(envelope.Result, &result); err != nil {
		return nil, fmt.Errorf("decode satellite task result: %w", err)
	}
	return &result, nil
}

func (d *RemoteDispatcher) authorize(req *http.Request) {
	req.Header.Set(InternalDispatchTokenHeader, "Bearer "+d.token)
}

type linksResponse struct {
	Links []linkIdentity `json:"links"`
}

type linkIdentity struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
}

type dispatchRequest struct {
	Namespace string          `json:"namespace"`
	Name      string          `json:"name"`
	Task      json.RawMessage `json:"task"`
}

type dispatchResponse struct {
	Result json.RawMessage `json:"result,omitempty"`
}

// NewInternalHandler serves the internal dispatch routes for a hub.
//
// token is required: an empty token refuses every request. The listener is
// in-cluster only, but a shared token still keeps any workload in the cluster
// from pushing manifests into satellites through it.
// internalHandler serves the two dispatch routes for one hub.
type internalHandler struct {
	hub   *Hub
	token string
}

func NewInternalHandler(hub *Hub, token string) http.Handler {
	handler := &internalHandler{hub: hub, token: token}
	mux := http.NewServeMux()
	mux.HandleFunc(InternalDispatchPrefix+"links", handler.links)
	mux.HandleFunc(InternalDispatchPrefix+"dispatch", handler.dispatch)
	return mux
}

func (h *internalHandler) links(w http.ResponseWriter, r *http.Request) {
	if !authorizeInternal(w, r, h.token) {
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	keys := h.hub.ConnectedClusters()
	payload := linksResponse{Links: make([]linkIdentity, 0, len(keys))}
	for _, key := range keys {
		payload.Links = append(payload.Links, linkIdentity{Namespace: key.Namespace, Name: key.Name})
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *internalHandler) dispatch(w http.ResponseWriter, r *http.Request) {
	if !authorizeInternal(w, r, h.token) {
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var request dispatchRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&request); err != nil {
		http.Error(w, "invalid dispatch request", http.StatusBadRequest)
		return
	}
	var task paprikav1.SatelliteTask
	if err := protojson.Unmarshal(request.Task, &task); err != nil {
		http.Error(w, "invalid satellite task", http.StatusBadRequest)
		return
	}
	key := types.NamespacedName{Namespace: request.Namespace, Name: request.Name}
	result, err := h.hub.Dispatch(r.Context(), key, &task)
	if err != nil {
		if errors.Is(err, ErrSatelliteOffline) {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	encoded, err := protojson.Marshal(result)
	if err != nil {
		http.Error(w, "encode satellite task result", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, dispatchResponse{Result: encoded})
}

func authorizeInternal(w http.ResponseWriter, r *http.Request, token string) bool {
	if token == "" {
		http.Error(w, "internal dispatch is not configured", http.StatusServiceUnavailable)
		return false
	}
	presented := strings.TrimSpace(strings.TrimPrefix(r.Header.Get(InternalDispatchTokenHeader), "Bearer "))
	if subtle.ConstantTimeCompare([]byte(presented), []byte(token)) != 1 {
		http.Error(w, "internal credential refused", http.StatusUnauthorized)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		// The status line is already on the wire, so the only report left is a
		// truncated body the caller's decoder rejects.
		return
	}
}

func closeBody(resp *http.Response) {
	if err := resp.Body.Close(); err != nil {
		return
	}
}
