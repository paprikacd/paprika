package satellite

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/version"
)

// newSender builds the configured transport. It is the one place that decides
// between the stream and the pooled POST, so the collector never branches on
// transport.
func newSender(config *Config) (Sender, error) {
	if !config.Stream {
		return NewClient(*config)
	}
	return NewLinkSender(&LinkConfig{
		ControlPlaneURL:  config.ControlPlaneURL,
		ClusterNamespace: config.ClusterNamespace,
		ClusterName:      config.ClusterName,
		Version:          version.Version,
		TokenFile:        config.TokenFile,
		CAFile:           config.CAFile,
		Executor:         config.Executor,
	})
}

// Sender is the outbound transport a satellite uses for one encoded report.
// Two implementations exist: a pooled HTTPS POST and the bidirectional link.
// The collector depends on this interface rather than on either one, so the
// transport is a configuration choice and not a second publish loop.
type Sender interface {
	SendEncoded(ctx context.Context, body []byte) error
	Close()
}

// TaskExecutor runs work the control plane sends down the link.
//
// It is an interface because the satellite package must not depend on how
// manifests are applied: the same apply path is used by the inbound agent, and
// binding the two would make the link's test a cluster test.
type TaskExecutor interface {
	Apply(ctx context.Context, namespace, appName string, manifests []byte) (applied int, errs []string, err error)
}

// LinkConfig configures the stream transport.
type LinkConfig struct {
	ControlPlaneURL  string
	ClusterNamespace string
	ClusterName      string
	Version          string
	TokenFile        string
	CAFile           string
	Executor         TaskExecutor
	// HTTPClient overrides the transport. Tests use it to reach an in-process
	// server over its own TLS certificate; production always builds its own.
	HTTPClient *http.Client
}

// DefaultLinkAckTimeout bounds the wait for one acknowledgement. It exists so a
// half-open connection fails rather than parking the publish loop forever.
const DefaultLinkAckTimeout = 30 * time.Second

// LinkSender sends reports over the bidirectional link and runs the tasks the
// control plane sends back.
//
// It is not safe for concurrent SendEncoded calls; the collector publishes one
// report at a time by design, and a second publisher would race the sequence
// fence regardless of transport.
type LinkSender struct {
	config   LinkConfig
	endpoint string
	http     *http.Client

	// ctx bounds every task the link runs. It is owned here because the work
	// outlives any single SendEncoded call and must stop when the sender closes.
	ctx    context.Context
	cancel context.CancelFunc

	mu      sync.Mutex
	stream  *connect.BidiStreamForClient[paprikav1.SatelliteFrame, paprikav1.SatelliteFrame]
	acks    chan *paprikav1.SatelliteAck
	sendMu  sync.Mutex
	dead    chan struct{}
	deadErr error
}

var _ Sender = (*LinkSender)(nil)

// NewLinkSender builds the stream transport. Plain HTTP is allowed only for
// loopback, matching the POST client: a satellite credential must not travel
// unencrypted across a network.
func NewLinkSender(config *LinkConfig) (*LinkSender, error) {
	if config.TokenFile == "" {
		return nil, errors.New("satellite token file is required")
	}
	endpoint, err := linkEndpoint(config.ControlPlaneURL)
	if err != nil {
		return nil, err
	}
	base := config.HTTPClient
	if base == nil {
		transport, err := linkTransport(config.CAFile, config.TokenFile)
		if err != nil {
			return nil, err
		}
		base = &http.Client{Transport: transport}
	}
	// Auth is layered on whatever transport is in play, including an injected
	// one: an override changes how the connection is made, never whether the
	// credential is sent.
	httpClient := &http.Client{Transport: &tokenTransport{base: base.Transport, tokenFile: config.TokenFile}}
	// The sender owns its context: a task outlives the SendEncoded call that
	// opened the stream, and Close is what ends it.
	ctx, cancel := context.WithCancel(context.Background())
	return &LinkSender{
		config:   *config,
		endpoint: endpoint,
		http:     httpClient,
		ctx:      ctx,
		cancel:   cancel,
		acks:     make(chan *paprikav1.SatelliteAck, 1),
	}, nil
}

func linkEndpoint(base string) (string, error) {
	u, err := parseControlPlaneURL(base)
	if err != nil {
		return "", err
	}
	u.Path = strings.TrimRight(u.Path, "/")
	u.RawPath = ""
	return u.String(), nil
}

// linkTransport adds the rotation-aware credential to each request and keeps
// the same CA trust rules as the POST transport.
func linkTransport(caFile, tokenFile string) (http.RoundTripper, error) {
	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return nil, errors.New("satellite default HTTP transport is unavailable")
	}
	transport := base.Clone()
	transport.ForceAttemptHTTP2 = true
	transport.MaxIdleConnsPerHost = 2
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	if caFile != "" {
		roots, err := reportRoots(caFile)
		if err != nil {
			return nil, err
		}
		transport.TLSClientConfig.RootCAs = roots
	}
	return &tokenTransport{base: transport, tokenFile: tokenFile}, nil
}

// tokenTransport reads the mounted token per request, so a rotated Secret takes
// effect on the next reconnect without restarting the satellite.
type tokenTransport struct {
	base      http.RoundTripper
	tokenFile string
}

func (t *tokenTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	token, err := os.ReadFile(t.tokenFile)
	if err != nil {
		return nil, errors.New("read satellite token file failed")
	}
	credential := strings.TrimSpace(string(token))
	if credential == "" || strings.ContainsAny(credential, "\r\n\t ") {
		return nil, errors.New("satellite token file must contain one non-empty bearer token")
	}
	clone := req.Clone(req.Context())
	clone.Header.Set("Authorization", "Bearer "+credential)
	response, err := t.base.RoundTrip(clone)
	if err != nil {
		return nil, fmt.Errorf("satellite link request: %w", err)
	}
	return response, nil
}

// Connect establishes the stream if it is not already up.
func (s *LinkSender) connect(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stream != nil {
		return nil
	}
	client := v1connect.NewSatelliteLinkClient(s.http, s.endpoint)
	stream := client.Connect(ctx)
	if err := stream.Send(&paprikav1.SatelliteFrame{
		Frame: &paprikav1.SatelliteFrame_Hello{Hello: &paprikav1.SatelliteHello{
			ClusterNamespace: s.config.ClusterNamespace,
			ClusterName:      s.config.ClusterName,
			Version:          s.config.Version,
			ProtocolVersion:  int32(ProtocolVersion),
		}},
	}); err != nil {
		return fmt.Errorf("open satellite link: %w", err)
	}
	dead := make(chan struct{})
	s.stream, s.dead, s.deadErr = stream, dead, nil
	// The sender's context, not the caller's: a task may outlive this call and
	// must still stop when Close runs.
	go s.receive(s.ctx, stream, dead) //nolint:contextcheck // deliberate long-lived context owned by the sender.

	return nil
}

// receive routes acknowledgements to SendEncoded and runs tasks as they arrive.
func (s *LinkSender) receive(
	ctx context.Context,
	stream *connect.BidiStreamForClient[paprikav1.SatelliteFrame, paprikav1.SatelliteFrame],
	dead chan struct{},
) {
	for {
		frame, err := stream.Receive()
		if err != nil {
			s.fail(dead, err)
			return
		}
		switch {
		case frame.GetAck() != nil:
			select {
			case s.acks <- frame.GetAck():
			default:
				// A superseded ack has no waiter; dropping it is correct because
				// SendEncoded only ever has one report in flight.
			}
		case frame.GetTask() != nil:
			go s.runTask(ctx, stream, frame.GetTask())
		}
	}
}

// fail marks the stream unusable and wakes any waiting SendEncoded.
func (s *LinkSender) fail(dead chan struct{}, err error) {
	s.mu.Lock()
	if s.dead == dead {
		s.deadErr = err
		s.stream = nil
		close(dead)
	}
	s.mu.Unlock()
}

// runTask executes one task and answers it. A panic in an executor must not take
// the link down, so the result is always sent.
func (s *LinkSender) runTask(
	ctx context.Context,
	stream *connect.BidiStreamForClient[paprikav1.SatelliteFrame, paprikav1.SatelliteFrame],
	task *paprikav1.SatelliteTask,
) {
	result := &paprikav1.SatelliteTaskResult{Id: task.GetId()}
	apply := task.GetApply()
	switch {
	case apply != nil && s.config.Executor != nil:
		applied, errs, err := s.config.Executor.Apply(
			ctx, apply.GetNamespace(), apply.GetAppName(), apply.GetManifests())
		result.Applied = int32(min(applied, int(^uint32(0)>>1))) //nolint:gosec // bounded above
		result.Errors = errs
		result.Ok = err == nil && len(errs) == 0
		if err != nil {
			result.Error = err.Error()
		}
	case apply != nil:
		result.Error = "no task executor is configured on this satellite"
	default:
		result.Error = "unsupported satellite task"
	}
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	if err := stream.Send(&paprikav1.SatelliteFrame{
		Frame: &paprikav1.SatelliteFrame_TaskResult{TaskResult: result},
	}); err != nil {
		return
	}
}

// SendEncoded sends one report and waits for its acknowledgement.
func (s *LinkSender) SendEncoded(ctx context.Context, body []byte) error {
	sequence, err := reportSequence(body)
	if err != nil {
		return err
	}
	if err := s.connect(ctx); err != nil {
		return err
	}

	s.mu.Lock()
	stream, dead := s.stream, s.dead
	s.mu.Unlock()
	if stream == nil {
		return errors.New("satellite link is not connected")
	}

	s.sendMu.Lock()
	sendErr := stream.Send(&paprikav1.SatelliteFrame{
		Frame: &paprikav1.SatelliteFrame_Update{Update: &paprikav1.SatelliteUpdate{Report: body}},
	})
	s.sendMu.Unlock()
	if sendErr != nil {
		return fmt.Errorf("send satellite update: %w", sendErr)
	}
	return s.awaitAck(ctx, sequence, dead)
}

// awaitAck waits for the acknowledgement of one sequence.
func (s *LinkSender) awaitAck(ctx context.Context, sequence uint64, dead chan struct{}) error {
	ackCtx, cancel := context.WithTimeout(ctx, DefaultLinkAckTimeout)
	defer cancel()
	select {
	case ack := <-s.acks:
		if ack.GetResync() {
			return ErrResync
		}
		if ack.GetSequence() != sequence {
			return fmt.Errorf("satellite acknowledgement out of order: got %d, sent %d", ack.GetSequence(), sequence)
		}
		return nil
	case <-dead:
		s.mu.Lock()
		cause := s.deadErr
		s.mu.Unlock()
		if cause != nil {
			return fmt.Errorf("satellite link closed: %w", cause)
		}
		return errors.New("satellite link closed")
	case <-ackCtx.Done():
		return fmt.Errorf("await satellite acknowledgement: %w", ackCtx.Err())
	}
}

// Close tears the stream down. A close error is not actionable during shutdown.
func (s *LinkSender) Close() {
	s.mu.Lock()
	stream := s.stream
	s.stream = nil
	s.mu.Unlock()
	if stream != nil {
		_ = stream.CloseRequest()  //nolint:errcheck // closing a stream during shutdown has no recovery path.
		_ = stream.CloseResponse() //nolint:errcheck // as above.
	}
	s.cancel()
	s.http.CloseIdleConnections()
}

// reportSequence extracts the sequence a report carries. The acknowledgement
// echoes it, so reading it here is cheaper than threading it through the
// collector's publication state.
func reportSequence(body []byte) (uint64, error) {
	var envelope struct {
		Sequence uint64 `json:"sequence"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return 0, fmt.Errorf("read satellite report sequence: %w", err)
	}
	return envelope.Sequence, nil
}
