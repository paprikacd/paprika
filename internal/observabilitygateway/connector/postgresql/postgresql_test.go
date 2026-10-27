package postgresql

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/lib/pq"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/dataframe"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

const testConfig = `{"host":"127.0.0.1","database":"fixture","sslmode":"disable"}`

func TestDescriptorAndConfiguration(t *testing.T) {
	descriptor := New().Descriptor()
	require.Equal(t, "postgresql", descriptor.Name)
	require.True(t, descriptor.NeedsEgress)
	require.True(t, descriptor.CanSupply(connector.SignalMetrics))
	require.True(t, descriptor.CanSupply(connector.Signal("records")))
	require.False(t, descriptor.CanSupply(connector.SignalLogs))
	cfg, err := parseConfig(json.RawMessage(`{"host":"db.example.com","database":"app"}`))
	require.NoError(t, err)
	require.Equal(t, 5432, cfg.Port)
	require.Equal(t, "verify-full", cfg.SSLMode)
	for _, host := range []string{"127.0.0.1", "::1", "localhost"} {
		raw, err := json.Marshal(map[string]any{"host": host, "database": "test", "sslmode": "disable"})
		require.NoError(t, err)
		require.NoError(t, New().ValidateConfig(raw))
	}
	for _, source := range []string{
		`{}`, `null`, `[]`, `{"host":"db","database":"x","password":"sensitive"}`,
		`{"host":"db","database":"x","host":"127.0.0.1"}`, `{"host":"db","database":"x","port":0}`,
		`{"host":"db","database":"x","port":65536}`, `{"host":"db","database":"x","port":"5432"}`,
		`{"host":"db","database":"x","sslmode":"require"}`, `{"host":"db","database":"x","sslmode":"disable"}`,
		`{"host":"localhost.evil.test","database":"x","sslmode":"disable"}`, `{"host":"127.0.0.1,attacker","database":"x"}`,
		`{"host":"postgres://user:secret@host","database":"x"}`, `{"host":"/tmp/socket","database":"x"}`,
		`{"host":"[::1]","database":"x"}`, `{"host":"db hostaddr=attacker","database":"x"}`, `{"host":"db","database":""}`,
		`{"host":"db","database":"x","allowedSchemas":["public"]}`, `{"host":"db","database":"x"} {}`,
	} {
		t.Run(source, func(t *testing.T) {
			err := New().ValidateConfig(json.RawMessage(source))
			require.Error(t, err)
			require.NotContains(t, err.Error(), "sensitive")
			require.NotContains(t, err.Error(), "attacker")
		})
	}
}

func TestCredentialDocumentIsExplicitAndSanitized(t *testing.T) {
	credentials, err := parseCredentials([]byte(`{"username":"reader","password":"p'\\secret"}`))
	require.NoError(t, err)
	require.Equal(t, `p'\secret`, credentials.Password)
	for _, raw := range []string{"", `null`, `{}`, `{"username":"reader","password":""}`, `{"username":"reader","password":"secret","dsn":"private"}`, `{"username":"a","username":"b","password":"secret"}`} {
		_, err := parseCredentials([]byte(raw))
		require.Error(t, err)
		require.NotContains(t, err.Error(), "secret")
		require.NotContains(t, err.Error(), "private")
	}
}

func TestSQLReadOnlyShapeAndTypedBindings(t *testing.T) {
	for _, source := range []string{
		"SELECT 1 AS value", "  -- explanation\r\n SELECT 1; -- finish", "/* outer /* inner */ end */ SELECT '; DELETE' AS text",
		"WITH sample AS (SELECT 1 AS value) SELECT * FROM sample", `SELECT $$ ; DROP TABLE x; $$ AS text`,
		`SELECT $body$ 'quotes' ; UPDATE $body$ AS text`, `SELECT 'it''s safe' AS text`, `SELECT 1 AS "value"`,
	} {
		_, err := parseQuery(source)
		require.NoError(t, err, source)
	}
	query, err := parseQuery(`{"sql":"SELECT $1::text AS service, $2::numeric AS value, $3::bool AS enabled, $4::text AS missing","parameters":["'); DELETE FROM x; --",12345678901234567890.123,true,null],"projection":{"value":"value","labels":["service"]}}`)
	require.NoError(t, err)
	require.Equal(t, []any{"'); DELETE FROM x; --", "12345678901234567890.123", true, nil}, query.Parameters)
	require.Equal(t, "value", query.Projection.Value)
	health, err := parseQuery("")
	require.NoError(t, err)
	require.Equal(t, "SELECT 1 AS value", health.SQL)
}

func TestSQLRejectsWriteAndAlternateStatementShapes(t *testing.T) {
	for _, source := range []string{
		"DELETE FROM x", "SELECT 1; DELETE FROM x", "SELECT 1; SELECT 2", "SELECT 1;;",
		"SELECT 1 -- comment\r; DELETE FROM x", "SELECT 1 -- comment\r) AS x; COMMIT; SET default_transaction_read_only=off; DELETE FROM x; --",
		"WITH gone AS (DELETE FROM x RETURNING *) SELECT * FROM gone", "SELECT * INTO copied FROM x", "SELECT * FROM x FOR UPDATE",
		"SELECT * FROM x FOR KEY SHARE", "SELECT set_config('transaction_read_only','off',true)", `SELECT "set_config"('x','y',true)`,
		"SELECT nextval('seq')", "SELECT pg_advisory_lock(1)", "SELECT dblink_exec('private','DELETE')", "SELECT lo_export(1,'/private')",
		"SELECT pg_read_file('/private')", "COPY x TO PROGRAM 'private'", "CALL write_it()", "EXPLAIN ANALYZE DELETE FROM x",
		"SELECT E'\\x'; DELETE FROM x", `SELECT U&"set\005fconfig"('x','y',true)`, "SELECT 1 /* unfinished", "SELECT 'unfinished",
		"SELECT $$unfinished", "SELECT 1\x00", "SELECT $1::text", "SELECT $0", "SELECT ${name}",
		`{"sql":""}`, `{"sql":" ","parameters":[]}`, `{"sql":"SELECT $2","parameters":[1]}`, `{"sql":"SELECT 1","parameters":[1]}`, `{"sql":"SELECT $2","parameters":[1,2]}`,
		`{"sql":"SELECT $1","parameters":[{}]}`, `{"sql":"SELECT $1","parameters":[[]]}`, `{"sql":"SELECT 1","unknown":"private"}`,
		`{"sql":"SELECT 1","sql":"SELECT 2"}`, `{"sql":"SELECT 1","projection":{"value":"a","value":"b"}}`,
		`{"sql":"SELECT 1","parameters":[NaN]}`, `{"sql":"SELECT 1"} {}`, strings.Repeat(" ", 65<<10),
	} {
		t.Run(source[:min(len(source), 90)], func(t *testing.T) {
			_, err := parseQuery(source)
			require.Error(t, err)
			require.NotContains(t, err.Error(), "private")
		})
	}
}

func TestNormalizeValuesAndMetricInference(t *testing.T) {
	for _, pair := range []struct {
		kind          string
		input, output any
	}{
		{"number", int64(0), int64(0)}, {"number", -1.25, -1.25}, {"number", nil, nil}, {"boolean", false, false},
		{"string", []byte("0.1234567890123456789012345"), "0.1234567890123456789012345"}, {"string", int64(9007199254740993), "9007199254740993"},
		{"timestamp", time.Date(2026, 1, 2, 3, 4, 5, 123000000, time.FixedZone("east", 3600)), "2026-01-02T02:04:05.123Z"},
	} {
		value, err := normalizeCell(pair.input, pair.kind)
		require.NoError(t, err)
		require.Equal(t, pair.output, value)
	}
	for _, value := range []any{math.NaN(), math.Inf(1), "1.5", []byte("1.5")} {
		_, err := normalizeCell(value, "number")
		require.ErrorIs(t, err, errFrameBounds)
	}
	_, err := normalizeCell(strings.Repeat("x", dataframe.MaxCellBytes+1), "string")
	require.ErrorIs(t, err, errFrameBounds)
	frame := &dataframe.Frame{Columns: []dataframe.Column{{Key: "time", Type: "timestamp"}, {Key: "service", Type: "string"}, {Key: "value", Type: "number"}}}
	projection, err := inferProjection(frame)
	require.NoError(t, err)
	require.Equal(t, dataframe.Projection{Value: "value", Time: "time", Labels: []string{"service"}}, projection)
	frame.Columns = append(frame.Columns, dataframe.Column{Key: "date", Type: "timestamp"})
	_, err = inferProjection(frame)
	require.ErrorContains(t, err, "ambiguous")
	_, err = inferProjection(&dataframe.Frame{Columns: []dataframe.Column{{Key: "a", Type: "number"}, {Key: "b", Type: "number"}}})
	require.ErrorContains(t, err, "numeric")
}

func TestFailuresNeverExposeBackendText(t *testing.T) {
	for _, err := range []error{errors.New("password=private endpoint=private SQL=private"), &pq.Error{Code: "28P01", Message: "private"}, &pq.Error{Code: "42601", Detail: "private"}, errReaderRole, context.DeadlineExceeded, errFrameBounds} {
		result := queryError(err)
		require.NotEqual(t, connector.StateOK, result.State)
		require.NotContains(t, result.Reason, "private")
		require.Empty(t, result.Data)
	}
	result, err := New().Query(t.Context(), connector.QueryRequest{Signal: connector.SignalMetrics, Config: json.RawMessage(testConfig)})
	require.NoError(t, err)
	require.Equal(t, connector.StateNotConfigured, result.State)
	_, err = New().Query(t.Context(), connector.QueryRequest{Signal: connector.SignalLogs, Config: json.RawMessage(testConfig)})
	require.ErrorIs(t, err, connector.ErrUnsupported)
	result, err = New().Query(t.Context(), connector.QueryRequest{Signal: connector.Signal("records"), Config: json.RawMessage(testConfig), Query: `{"sql":"SELECT 1 AS value","projection":{"value":"value"}}`})
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, result.State)
}

func TestConnectionQueueHonorsCancellation(t *testing.T) {
	for range cap(connectionSlots) {
		connectionSlots <- struct{}{}
		defer func() { <-connectionSlots }()
	}
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	started := time.Now()
	result, err := New().Query(ctx, connector.QueryRequest{Signal: connector.SignalMetrics, Config: json.RawMessage(testConfig), Credentials: []byte(`{"username":"reader","password":"test"}`)})
	require.NoError(t, err)
	require.Equal(t, connector.StateError, result.State)
	require.Less(t, time.Since(started), time.Second)
}
