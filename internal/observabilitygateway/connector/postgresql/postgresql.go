// Package postgresql supplies bounded read-only SQL records and metric
// projections. Database privileges, not SQL string inspection, define access.
package postgresql

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/lib/pq"

	"github.com/benebsworth/paprika/internal/dataframe"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

const (
	queryTimeout = 5 * time.Second
	callTimeout  = 10 * time.Second
	defaultLimit = 100
)

var (
	connectionSlots = make(chan struct{}, 4)
	errReaderRole   = errors.New("postgresql requires an unprivileged reader role")
	errFrameBounds  = errors.New("postgresql result exceeds its scalar, column or response bounds")
)

// PostgreSQL opens one bounded connection per request and always rolls it back.
// No session state or credentials are retained in a connection cache.
type PostgreSQL struct{}

// New returns the SQL connector.
func New() connector.Connector { return PostgreSQL{} }

// Descriptor advertises SQL metrics and typed tabular records.
func (PostgreSQL) Descriptor() connector.Descriptor {
	return connector.Descriptor{Name: "postgresql", Signals: []connector.Signal{connector.SignalMetrics, connector.Signal("records")}, NeedsEgress: true}
}

// ValidateConfig rejects DSNs, inline credentials and unsafe TLS modes.
func (PostgreSQL) ValidateConfig(raw json.RawMessage) error {
	_, err := parseConfig(raw)
	return err
}

// Query executes a single SELECT in an explicitly read-only transaction.
//
//nolint:gocritic // QueryRequest is passed by value by the connector contract.
func (PostgreSQL) Query(ctx context.Context, req connector.QueryRequest) (*connector.QueryResult, error) {
	if req.Signal != connector.SignalMetrics && req.Signal != connector.Signal("records") {
		return unsupported("PostgreSQL supplies metrics and records only.")
	}
	if req.TraceID != "" || req.PageToken != "" {
		return unsupported("PostgreSQL queries do not support trace IDs or continuation tokens.")
	}
	cfg, err := parseConfig(req.Config)
	if err != nil {
		return nil, err
	}
	query, err := parseQuery(req.Query)
	if err != nil {
		return unsupported(err.Error())
	}
	if req.Signal == connector.Signal("records") && query.Projection != nil {
		return unsupported("SQL record queries do not accept a metric projection.")
	}
	return execute(ctx, &req, cfg, query)
}

func execute(ctx context.Context, req *connector.QueryRequest, cfg config, query queryDocument) (*connector.QueryResult, error) {
	if len(req.Credentials) == 0 {
		return &connector.QueryResult{State: connector.StateNotConfigured, Reason: "PostgreSQL requires a username and password credential Secret."}, nil
	}
	creds, err := parseCredentials(req.Credentials)
	if err != nil {
		return &connector.QueryResult{State: connector.StateForbidden, Reason: "PostgreSQL credential Secret must contain only a username and password."}, nil
	}
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	select {
	case connectionSlots <- struct{}{}:
		defer func() { <-connectionSlots }()
	case <-ctx.Done():
		return queryError(ctx.Err()), nil
	}
	limit := req.Limit
	if limit <= 0 {
		limit = defaultLimit
	}
	limit = min(limit, dataframe.MaxRows)
	frame, err := runQuery(ctx, cfg, creds, query, limit)
	if err != nil {
		return queryError(err), nil
	}
	if req.Signal == connector.Signal("records") {
		data, marshalErr := json.Marshal(frame)
		if marshalErr != nil {
			return queryError(errFrameBounds), nil
		}
		return &connector.QueryResult{State: connector.StateOK, Data: data}, nil
	}
	return metricResult(frame, query.Projection, req.Range.End)
}

func metricResult(frame *dataframe.Frame, projection *dataframe.Projection, end time.Time) (*connector.QueryResult, error) {
	if projection == nil {
		inferred, err := inferProjection(frame)
		if err != nil {
			return unsupported(err.Error())
		}
		projection = &inferred
	}
	data, err := dataframe.Prometheus(frame, *projection, end)
	if err != nil {
		return unsupported("SQL metric projection needs a numeric value, valid timestamp and distinct observations; specify projection or aggregate the query.")
	}
	return &connector.QueryResult{State: connector.StateOK, Data: data}, nil
}

func runQuery(ctx context.Context, cfg config, creds credentials, query queryDocument, limit int) (frame *dataframe.Frame, err error) {
	db, err := openDatabase(cfg, creds)
	if err != nil {
		return nil, err
	}
	defer finishClose(db.Close, &err)
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, fmt.Errorf("begin read-only SQL transaction: %w", err)
	}
	defer finishClose(tx.Rollback, &err)
	// Fixed statements only; never interpolate caller configuration here.
	for _, statement := range []string{
		"SET LOCAL statement_timeout = '5s'",
		"SET LOCAL lock_timeout = '1s'",
		"SET LOCAL idle_in_transaction_session_timeout = '5s'",
		"SET LOCAL search_path = pg_catalog, public",
	} {
		if _, setupErr := tx.ExecContext(ctx, statement); setupErr != nil {
			return nil, fmt.Errorf("configure SQL transaction: %w", setupErr)
		}
	}
	var privileged bool
	if roleErr := tx.QueryRowContext(ctx, readerRoleQuery).Scan(&privileged); roleErr != nil {
		return nil, fmt.Errorf("check SQL reader role: %w", roleErr)
	}
	if privileged {
		return nil, errReaderRole
	}
	// Wrapping prevents statement forms that cannot be used as a SELECT source.
	// Read one extra row to distinguish a complete result from truncation.
	statement := "SELECT * FROM (\n" + query.SQL + "\n) AS paprika_query LIMIT " + strconv.Itoa(limit+1) //nolint:gosec // Native SQL is the input; values are bound separately and statement shape is validated.
	// Always use the extended protocol, including queries with no parameters.
	// PostgreSQL itself rejects multiple commands in a prepared statement.
	prepared, err := tx.PrepareContext(ctx, statement)
	if err != nil {
		return nil, fmt.Errorf("prepare bounded SQL query: %w", err)
	}
	defer finishClose(prepared.Close, &err)
	rows, err := prepared.QueryContext(ctx, query.Parameters...)
	if err != nil {
		return nil, fmt.Errorf("execute bounded SQL query: %w", err)
	}
	defer finishClose(rows.Close, &err)
	return readFrame(rows, limit)
}

//nolint:gocritic // The pointer updates the named return value from deferred cleanup.
func finishClose(closeResource func() error, result *error) {
	if err := closeResource(); err != nil && *result == nil && !errors.Is(err, sql.ErrTxDone) {
		*result = fmt.Errorf("close read-only SQL request: %w", err)
	}
}

const readerRoleQuery = `SELECT EXISTS (
 SELECT 1 FROM pg_catalog.pg_roles AS r
 WHERE pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER')
 AND (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls
 OR r.rolname IN ('pg_write_all_data', 'pg_read_server_files', 'pg_write_server_files',
 'pg_execute_server_program', 'pg_signal_backend', 'pg_checkpoint', 'pg_maintain', 'pg_create_subscription'))
)`

func openDatabase(cfg config, creds credentials) (*sql.DB, error) {
	// Construct directly: pq.NewConfig/DSNs read PG* environment and service
	// files. A nonempty explicit password also prevents .pgpass lookup.
	driver, err := pq.NewConnectorConfig(pq.Config{
		Host: cfg.Host, Port: uint16(cfg.Port), Database: cfg.Database, //nolint:gosec // parseConfig validates port in [1,65535].
		User: creds.Username, Password: creds.Password,
		SSLMode:        pq.SSLModeDisable, // TLS is negotiated by our isolated dialer.
		ConnectTimeout: queryTimeout, ApplicationName: "paprika-observe",
		ClientEncoding: "UTF8", Datestyle: "ISO, MDY", TZ: "UTC",
		Runtime: map[string]string{"default_transaction_read_only": "on", "statement_timeout": "5000", "lock_timeout": "1000"},
	})
	if err != nil {
		return nil, fmt.Errorf("configure SQL driver: %w", err)
	}
	driver.Dialer(secureDialer{host: cfg.Host, encrypted: cfg.SSLMode == "verify-full"})
	db := sql.OpenDB(driver)
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(callTimeout)
	return db, nil
}

func unsupported(reason string) (*connector.QueryResult, error) {
	return &connector.QueryResult{State: connector.StateNotAvailable, Reason: reason}, fmt.Errorf("%w: %s", connector.ErrUnsupported, reason)
}

func queryError(err error) *connector.QueryResult {
	result := &connector.QueryResult{State: connector.StateError, Reason: "PostgreSQL query failed. Check the read-only SQL, column types and provider connection."}
	var postgresError *pq.Error
	switch {
	case errors.Is(err, errReaderRole):
		result.State, result.Reason = connector.StateForbidden, "PostgreSQL requires a dedicated reader role without privileged role attributes or memberships."
	case errors.Is(err, errFrameBounds):
		result.Reason = "PostgreSQL result exceeds its scalar, column or response bounds. Select fewer columns or cast unsupported values to text."
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		result.Reason = "PostgreSQL query was canceled or timed out."
	case errors.As(err, &postgresError):
		switch postgresError.Code {
		case "28000", "28P01", "42501", "25006":
			result.State, result.Reason = connector.StateForbidden, "PostgreSQL denied the read-only query or supplied credentials."
		case "57014", "55P03":
			result.Reason = "PostgreSQL query was canceled or timed out."
		}
	}
	return result
}
