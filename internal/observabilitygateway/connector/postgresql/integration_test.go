package postgresql

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lib/pq"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/dataframe"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// Optional real-protocol integration: only an explicitly configured loopback
// test database is accepted. No production credentials or providers are read.
func TestPostgreSQLIntegration(t *testing.T) {
	dsn := os.Getenv("PAPRIKA_POSTGRES_TEST_DSN")
	if dsn == "" {
		t.Skip("set PAPRIKA_POSTGRES_TEST_DSN to an isolated loopback PostgreSQL test database")
	}
	address, err := url.Parse(dsn)
	require.NoError(t, err)
	require.True(t, net.ParseIP(address.Hostname()).IsLoopback(), "integration database must use a literal loopback IP")
	require.Equal(t, "disable", address.Query().Get("sslmode"))
	db, err := sql.Open("postgres", dsn)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	require.NoError(t, db.PingContext(t.Context()))
	role := "paprika_reader_" + strconv.FormatInt(time.Now().UnixNano(), 36)
	schema := role
	quoted := pq.QuoteIdentifier(schema)
	password := "local-fixture-reader"
	_, err = db.ExecContext(t.Context(), "CREATE ROLE "+pq.QuoteIdentifier(role)+" LOGIN PASSWORD "+pq.QuoteLiteral(password)+" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS")
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(), "DROP SCHEMA IF EXISTS "+quoted+" CASCADE")
		_, _ = db.ExecContext(context.Background(), "DROP ROLE IF EXISTS "+pq.QuoteIdentifier(role))
	})
	for _, statement := range []string{
		"CREATE SCHEMA " + quoted,
		"CREATE TABLE " + quoted + ".events (observed timestamptz, service text, value double precision)",
		"INSERT INTO " + quoted + ".events VALUES ('2026-10-27T00:00:00Z', 'api', 0), ('2026-10-27T00:00:30Z', 'api', NULL), ('2026-10-27T00:00:00Z', 'worker', 2.5)",
		"GRANT USAGE ON SCHEMA " + quoted + " TO " + pq.QuoteIdentifier(role),
		"GRANT SELECT ON " + quoted + ".events TO " + pq.QuoteIdentifier(role),
		"CREATE FUNCTION " + quoted + ".mutate() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN INSERT INTO " + quoted + ".events VALUES (now(),'forbidden',99); RETURN 1; END $$",
	} {
		_, err = db.ExecContext(t.Context(), statement)
		require.NoError(t, err)
	}
	port, err := strconv.Atoi(address.Port())
	require.NoError(t, err)
	cfg, err := json.Marshal(config{Host: address.Hostname(), Port: port, Database: strings.TrimPrefix(address.Path, "/"), SSLMode: "disable"})
	require.NoError(t, err)
	creds, err := json.Marshal(credentials{Username: role, Password: password}) //nolint:gosec // Explicit local fixture credential document exercises the production Secret format.
	require.NoError(t, err)
	query := func(ctx context.Context, expression string, kind connector.Signal, limit int) (*connector.QueryResult, error) {
		return New().Query(ctx, connector.QueryRequest{Config: cfg, Credentials: creds, Query: expression, Signal: kind, Limit: limit, Range: connector.TimeRange{End: time.Date(2026, 10, 27, 0, 1, 0, 0, time.UTC)}})
	}
	records := func(expression string, limit int) *dataframe.Frame {
		t.Helper()
		result, err := query(t.Context(), expression, connector.Signal("records"), limit)
		require.NoError(t, err)
		require.Equal(t, connector.StateOK, result.State, result.Reason)
		frame, err := dataframe.Decode(result.Data)
		require.NoError(t, err)
		return frame
	}

	t.Run("records exact scalars timestamps and typed parameters", func(t *testing.T) {
		frame := records(`SELECT current_setting('transaction_read_only') AS readonly, current_setting('statement_timeout') AS timeout, false AS enabled, 0::int AS zero, NULL::text AS missing`, 10)
		require.Equal(t, []any{"on", "5s", false, json.Number("0"), nil}, frame.Rows[0])
		injection := "api'); DELETE FROM " + quoted + ".events; --"
		envelope, err := json.Marshal(queryDocument{SQL: "SELECT $1::text AS service, $2::float8 AS value, $3::boolean AS enabled, $4::text AS missing", Parameters: []any{injection, 1.25, false, nil}})
		require.NoError(t, err)
		frame = records(string(envelope), 10)
		require.Equal(t, []any{injection, json.Number("1.25"), false, nil}, frame.Rows[0])
		frame = records("SELECT observed AS time, service, value FROM "+quoted+".events ORDER BY observed, service", 10)
		require.Equal(t, "timestamp", frame.Columns[0].Type)
		require.Equal(t, "2026-10-27T00:00:00Z", frame.Rows[0][0])
		require.Len(t, frame.Rows, 3)
	})
	t.Run("large integers and decimals retain exact text", func(t *testing.T) {
		frame := records("SELECT x AS id, 0.12345678901234567890123456789::numeric AS amount FROM (VALUES (1::bigint),(9007199254740993::bigint)) AS input(x)", 10)
		require.Equal(t, "string", frame.Columns[0].Type)
		require.Equal(t, "string", frame.Columns[1].Type)
		require.Equal(t, []any{"1", "0.12345678901234567890123456789"}, frame.Rows[0])
		require.Equal(t, "9007199254740993", frame.Rows[1][0])
	})
	t.Run("range references bind historical inclusive boundaries", func(t *testing.T) {
		envelope, err := json.Marshal(map[string]any{
			"sql":        "SELECT observed, service FROM " + quoted + ".events WHERE observed >= $1::timestamptz AND observed <= $2::timestamptz ORDER BY observed,service",
			"parameters": []any{map[string]string{"range": "start"}, map[string]string{"range": "end"}},
		})
		require.NoError(t, err)
		start := time.Date(2026, 10, 27, 0, 0, 0, 0, time.UTC)
		request := connector.QueryRequest{Config: cfg, Credentials: creds, Query: string(envelope), Signal: connector.Signal("records"), Limit: 10, Range: connector.TimeRange{Start: start, End: start.Add(30 * time.Second)}}
		result, err := New().Query(t.Context(), request)
		require.NoError(t, err)
		frame, err := dataframe.Decode(result.Data)
		require.NoError(t, err)
		require.Len(t, frame.Rows, 3, "both start and end observations are included by these SQL operators")
		request.Range = connector.TimeRange{Start: start.Add(31 * time.Second), End: start.Add(time.Minute)}
		result, err = New().Query(t.Context(), request)
		require.NoError(t, err)
		frame, err = dataframe.Decode(result.Data)
		require.NoError(t, err)
		require.Empty(t, frame.Rows)
	})
	t.Run("ambient driver settings do not change the explicit connection", func(t *testing.T) {
		t.Setenv("PGHOST", "untrusted.invalid")
		t.Setenv("PGUSER", "untrusted")
		t.Setenv("PGPASSWORD", "untrusted")
		t.Setenv("PGSERVICE", "untrusted")
		t.Setenv("PGOPTIONS", "-c default_transaction_read_only=off")
		frame := records("SELECT current_user::text AS username, current_setting('transaction_read_only') AS readonly", 10)
		require.Equal(t, []any{role, "on"}, frame.Rows[0])
	})
	t.Run("metric history projection and null gaps", func(t *testing.T) {
		envelope, err := json.Marshal(queryDocument{SQL: "SELECT observed, service, value FROM " + quoted + ".events WHERE service=$1 ORDER BY observed", Parameters: []any{"api"}, Projection: &dataframe.Projection{Value: "value", Time: "observed", Labels: []string{"service"}}})
		require.NoError(t, err)
		result, err := query(t.Context(), string(envelope), connector.SignalMetrics, 10)
		require.NoError(t, err)
		require.Equal(t, connector.StateOK, result.State, result.Reason)
		var body struct {
			Data struct {
				Result []struct {
					Metric map[string]string
					Values [][]any
				}
			}
		}
		require.NoError(t, json.Unmarshal(result.Data, &body))
		require.Len(t, body.Data.Result, 1)
		require.Equal(t, "api", body.Data.Result[0].Metric["service"])
		require.Equal(t, "0", body.Data.Result[0].Values[0][1])
		require.Equal(t, "NaN", body.Data.Result[0].Values[1][1])
		result, err = query(t.Context(), "SELECT 12.5::float8 AS value", connector.SignalMetrics, 10)
		require.NoError(t, err)
		require.Equal(t, connector.StateOK, result.State)
		result, err = query(t.Context(), "SELECT 1 AS one, 2 AS two", connector.SignalMetrics, 10)
		require.ErrorIs(t, err, connector.ErrUnsupported)
		require.Equal(t, connector.StateNotAvailable, result.State)
	})
	t.Run("bounded rows columns cells and total bytes", func(t *testing.T) {
		require.True(t, records("SELECT generate_series(1,10) AS value", 3).Truncated)
		require.False(t, records("SELECT generate_series(1,3) AS value", 3).Truncated)
		require.Len(t, records("SELECT generate_series(1,2000) AS value", 5000).Rows, dataframe.MaxRows)
		require.Empty(t, records("SELECT 1 AS value WHERE false", 10).Rows)
		columns := make([]string, 65)
		for index := range columns {
			columns[index] = fmt.Sprintf("1 AS c%d", index)
		}
		for _, expression := range []string{"SELECT repeat('x',16385) AS oversized", "SELECT " + strings.Join(columns, ","), "SELECT generate_series(1,1000) AS id, repeat('x',5000) AS bytes", "SELECT 'NaN'::float8 AS value", "SELECT interval '1 hour' AS unsupported"} {
			result, err := query(t.Context(), expression, connector.Signal("records"), 1000)
			require.NoError(t, err)
			require.Equal(t, connector.StateError, result.State)
			require.Contains(t, result.Reason, "bounds")
		}
	})
	t.Run("writes refused including a security definer function", func(t *testing.T) {
		for _, expression := range []string{"DELETE FROM " + quoted + ".events", "WITH changed AS (DELETE FROM " + quoted + ".events RETURNING *) SELECT * FROM changed", "SELECT 1; DELETE FROM " + quoted + ".events"} {
			_, err := query(t.Context(), expression, connector.Signal("records"), 10)
			require.ErrorIs(t, err, connector.ErrUnsupported)
		}
		result, err := query(t.Context(), "SELECT "+quoted+".mutate() AS value", connector.SignalMetrics, 10)
		require.NoError(t, err)
		require.Equal(t, connector.StateForbidden, result.State)
		var count int
		require.NoError(t, db.QueryRowContext(context.Background(), "SELECT count(*) FROM "+quoted+".events").Scan(&count))
		require.Equal(t, 3, count)
	})
	t.Run("privileged roles and credentials rejected", func(t *testing.T) {
		for _, grants := range [][2]string{{"ALTER ROLE " + pq.QuoteIdentifier(role) + " CREATEDB", "ALTER ROLE " + pq.QuoteIdentifier(role) + " NOCREATEDB"}, {"GRANT pg_write_all_data TO " + pq.QuoteIdentifier(role), "REVOKE pg_write_all_data FROM " + pq.QuoteIdentifier(role)}} {
			_, err := db.ExecContext(context.Background(), grants[0])
			require.NoError(t, err)
			result, queryErr := query(t.Context(), "SELECT 1 AS value", connector.SignalMetrics, 10)
			_, err = db.ExecContext(context.Background(), grants[1])
			require.NoError(t, err)
			require.NoError(t, queryErr)
			require.Equal(t, connector.StateForbidden, result.State)
			require.Contains(t, result.Reason, "reader role")
		}
		result, err := New().Query(t.Context(), connector.QueryRequest{Config: cfg, Credentials: []byte(`{"username":"missing","password":"private-password"}`), Signal: connector.SignalMetrics})
		require.NoError(t, err)
		require.Equal(t, connector.StateForbidden, result.State)
		require.NotContains(t, result.Reason, "private-password")
		adminPassword, _ := address.User.Password()
		adminCredentials, marshalErr := json.Marshal(map[string]string{"username": address.User.Username(), "password": adminPassword})
		require.NoError(t, marshalErr)
		result, err = New().Query(t.Context(), connector.QueryRequest{Config: cfg, Credentials: adminCredentials, Signal: connector.SignalMetrics})
		require.NoError(t, err)
		require.Equal(t, connector.StateForbidden, result.State)
		require.Contains(t, result.Reason, "reader role")
	})
	t.Run("lock waits are bounded independently of statement timeout", func(t *testing.T) {
		transaction, err := db.BeginTx(t.Context(), nil)
		require.NoError(t, err)
		defer transaction.Rollback()
		_, err = transaction.ExecContext(t.Context(), "LOCK TABLE "+quoted+".events IN ACCESS EXCLUSIVE MODE")
		require.NoError(t, err)
		started := time.Now()
		result, err := query(t.Context(), "SELECT * FROM "+quoted+".events", connector.Signal("records"), 10)
		require.NoError(t, err)
		require.Equal(t, connector.StateError, result.State)
		require.Contains(t, result.Reason, "timed out")
		require.Less(t, time.Since(started), 2*time.Second)
	})
	t.Run("cancellation statement timeout and connection closure", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
		defer cancel()
		started := time.Now()
		result, err := query(ctx, "SELECT pg_sleep(2)", connector.Signal("records"), 10)
		require.NoError(t, err)
		require.Equal(t, connector.StateError, result.State)
		require.Less(t, time.Since(started), time.Second)
		started = time.Now()
		result, err = query(t.Context(), "SELECT pg_sleep(6)", connector.Signal("records"), 10)
		require.NoError(t, err)
		require.Equal(t, connector.StateError, result.State)
		require.Contains(t, result.Reason, "timed out")
		require.Less(t, time.Since(started), 6*time.Second)
		require.Eventually(t, func() bool {
			var count int
			return db.QueryRowContext(context.Background(), "SELECT count(*) FROM pg_stat_activity WHERE application_name='paprika-observe'").Scan(&count) == nil && count == 0
		}, time.Second, 20*time.Millisecond)
	})
}
