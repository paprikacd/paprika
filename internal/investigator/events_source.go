package investigator

import "context"

// EventsSource is a placeholder Source for K8s events. The handler pre-loads
// events into Input.Events so this collector returns no evidence directly.
type EventsSource struct{}

// Name returns the source identifier.
func (s *EventsSource) Name() string { return "events" }

// Collect returns no evidence; events are pre-loaded by the handler.
func (s *EventsSource) Collect(ctx context.Context, ref ResourceRef) ([]Evidence, error) { //nolint:gocritic // DataSource interface takes ResourceRef by value.
	return nil, nil
}
