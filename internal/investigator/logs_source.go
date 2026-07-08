package investigator

import "context"

// LogsSource is a placeholder Source for pod logs. The handler pre-loads the
// last N log lines into Input.Logs so this collector returns no evidence.
type LogsSource struct{}

// Name returns the source identifier.
func (s *LogsSource) Name() string { return "logs" }

// Collect returns no evidence; logs are pre-loaded by the handler.
func (s *LogsSource) Collect(ctx context.Context, ref ResourceRef) ([]Evidence, error) { //nolint:gocritic // DataSource interface takes ResourceRef by value.
	return nil, nil
}
