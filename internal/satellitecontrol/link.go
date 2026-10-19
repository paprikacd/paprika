package satellitecontrol

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"connectrpc.com/connect"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/log"

	clusters "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/metrics"
)

// LinkPrefix is where the generated Connect handler mounts the stream.
const LinkPrefix = "/paprika.v1.SatelliteLink/"

// LinkServer serves the satellite stream: observations up, tasks down.
//
// It owns no state of its own. A report accepted here goes through the same
// validation, sequence fence and status write as the HTTP transport, so the two
// paths cannot disagree about what has been accepted.
type LinkServer struct {
	handler *Handler
	hub     *Hub
}

// NewLinkServer wires the stream front end onto the report handler and hub.
func NewLinkServer(handler *Handler, hub *Hub) *LinkServer {
	return &LinkServer{handler: handler, hub: hub}
}

// Connect runs one satellite stream until it ends.
func (s *LinkServer) Connect(
	ctx context.Context,
	stream *connect.BidiStream[paprikav1.SatelliteFrame, paprikav1.SatelliteFrame],
) error {
	cluster, key, token, err := s.handshake(ctx, stream)
	if err != nil {
		metrics.SatelliteLinkEvents.Add(ctx, 1, metrics.SatelliteLinkAttributes(metrics.SatelliteLinkRefused))
		return err
	}

	link := s.hub.Attach(key)
	metrics.SatelliteLinkEvents.Add(ctx, 1, metrics.SatelliteLinkAttributes(metrics.SatelliteLinkAttached))
	defer func() {
		s.hub.Detach(key, link)
		metrics.SatelliteLinkEvents.Add(ctx, 1, metrics.SatelliteLinkAttributes(metrics.SatelliteLinkDetached))
	}()

	logger := log.FromContext(ctx)
	logger.Info("Satellite link attached", "cluster", key.String())
	defer logger.Info("Satellite link detached", "cluster", key.String())

	return s.serve(ctx, stream, link, token, cluster)
}

// handshake validates the first frame and the credential it presents.
func (s *LinkServer) handshake(
	ctx context.Context,
	stream *connect.BidiStream[paprikav1.SatelliteFrame, paprikav1.SatelliteFrame],
) (*clusters.Cluster, types.NamespacedName, string, error) {
	first, err := stream.Receive()
	if err != nil {
		return nil, types.NamespacedName{}, "", connect.NewError(connect.CodeInvalidArgument,
			errors.New("satellite stream closed before its hello"))
	}
	hello := first.GetHello()
	if hello == nil {
		return nil, types.NamespacedName{}, "", connect.NewError(connect.CodeInvalidArgument,
			errors.New("the first frame must be a hello"))
	}
	token, err := bearerToken(stream.RequestHeader())
	if err != nil {
		return nil, types.NamespacedName{}, "", connect.NewError(connect.CodeUnauthenticated, err)
	}
	cluster, err := s.handler.Authenticate(
		ctx, hello.GetClusterNamespace(), hello.GetClusterName(), token)
	if err != nil {
		return nil, types.NamespacedName{}, "", connect.NewError(connect.CodePermissionDenied, err)
	}
	if hello.GetClusterUid() != "" &&
		cluster.Status.Satellite != nil &&
		cluster.Status.Satellite.ClusterUID != "" &&
		cluster.Status.Satellite.ClusterUID != hello.GetClusterUid() {
		// A registration is bound to one physical cluster. Refusing here keeps a
		// reused name from inheriting another cluster's baseline.
		return nil, types.NamespacedName{}, "", connect.NewError(connect.CodePermissionDenied,
			errors.New("cluster identity mismatch on the registration"))
	}
	key := types.NamespacedName{Namespace: cluster.Namespace, Name: cluster.Name}
	return cluster, key, token, nil
}

// serve pumps frames in both directions until either side ends.
func (s *LinkServer) serve(
	ctx context.Context,
	stream *connect.BidiStream[paprikav1.SatelliteFrame, paprikav1.SatelliteFrame],
	link *Link,
	token string,
	cluster *clusters.Cluster,
) error {
	updates := make(chan *paprikav1.SatelliteUpdate)
	readErr := make(chan error, 1)
	go readSatelliteFrames(ctx, stream, link, updates, readErr)

	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-readErr:
			if errors.Is(err, errStreamClosed) {
				return nil
			}
			return err
		case task := <-link.out:
			if err := stream.Send(&paprikav1.SatelliteFrame{
				Frame: &paprikav1.SatelliteFrame_Task{Task: task},
			}); err != nil {
				return fmt.Errorf("send satellite task: %w", err)
			}
		case update := <-updates:
			if err := s.acceptUpdate(ctx, stream, update, token); err != nil {
				return err
			}
		}
	}
}

var errStreamClosed = errors.New("satellite stream closed")

// readSatelliteFrames demultiplexes one stream. Receive must run in its own
// goroutine: the connection is bidirectional, so the writer cannot block on it.
func readSatelliteFrames(
	ctx context.Context,
	stream *connect.BidiStream[paprikav1.SatelliteFrame, paprikav1.SatelliteFrame],
	link *Link,
	updates chan<- *paprikav1.SatelliteUpdate,
	readErr chan<- error,
) {
	for {
		frame, err := stream.Receive()
		if err != nil {
			readErr <- streamEnd(err)
			return
		}
		switch {
		case frame.GetUpdate() != nil:
			select {
			case updates <- frame.GetUpdate():
			case <-ctx.Done():
				return
			}
		case frame.GetTaskResult() != nil:
			link.complete(frame.GetTaskResult())
		default:
			readErr <- connect.NewError(connect.CodeInvalidArgument,
				errors.New("satellite frames must carry an update or a task result"))
			return
		}
	}
}

// streamEnd maps a normal close to errStreamClosed so the caller can end the
// handler without reporting a failure.
func streamEnd(err error) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, io.EOF) {
		return errStreamClosed
	}
	var connectErr *connect.Error
	if errors.As(err, &connectErr) && connectErr.Code() == connect.CodeCanceled {
		return errStreamClosed
	}
	return err
}

// acceptUpdate persists one report and acknowledges it by the sequence the
// satellite carried.
//
// A rejected baseline answers with resync rather than a stream error: the
// satellite must open a new session, and a transport failure would only make it
// retry the same rejected report. Any other failure is returned so the stream
// ends and the satellite reconnects, which is what the HTTP transport's retry
// loop amounts to.
func (s *LinkServer) acceptUpdate(
	ctx context.Context,
	stream *connect.BidiStream[paprikav1.SatelliteFrame, paprikav1.SatelliteFrame],
	update *paprikav1.SatelliteUpdate,
	token string,
) error {
	started := time.Now()
	outcome := metrics.SatelliteReportRejected
	defer func() {
		attrs := metrics.SatelliteReportAttributes(metrics.SatelliteTransportStream, outcome)
		metrics.SatelliteReports.Add(ctx, 1, attrs)
		metrics.SatelliteReportDuration.Record(ctx, time.Since(started).Seconds(), attrs)
	}()

	report, err := decodeReport(update.GetReport())
	if err != nil {
		// An undecodable report is a satellite bug or a version mismatch. It is
		// not recoverable by resync, so fail the stream.
		return connect.NewError(connect.CodeInvalidArgument, err)
	}
	digestBytes := sha256.Sum256(update.GetReport())
	digest := hex.EncodeToString(digestBytes[:])
	if err := s.handler.accept(ctx, report, token, digest); err != nil {
		var refusal *reportError
		if errors.As(err, &refusal) && refusal.code == http.StatusConflict {
			if sendErr := stream.Send(&paprikav1.SatelliteFrame{
				Frame: &paprikav1.SatelliteFrame_Ack{Ack: &paprikav1.SatelliteAck{
					Sequence: report.Sequence, Resync: true,
				}},
			}); sendErr != nil {
				return fmt.Errorf("send resync acknowledgement: %w", sendErr)
			}
			outcome = metrics.SatelliteReportResync
			return nil
		}
		return fmt.Errorf("accept satellite update: %w", err)
	}
	outcome = metrics.SatelliteReportAccepted
	metrics.SatelliteReportBytes.Record(ctx, int64(len(update.GetReport())))
	if sendErr := stream.Send(&paprikav1.SatelliteFrame{
		Frame: &paprikav1.SatelliteFrame_Ack{Ack: &paprikav1.SatelliteAck{
			Sequence: report.Sequence,
		}},
	}); sendErr != nil {
		return fmt.Errorf("send satellite acknowledgement: %w", sendErr)
	}
	return nil
}

func bearerToken(header http.Header) (string, error) {
	auth := header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return "", errors.New("satellite credential required")
	}
	token := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
	if token == "" {
		return "", errors.New("satellite credential required")
	}
	return token, nil
}
