# PostgreSQL bindings

A saved PostgreSQL query keeps its SQL text fixed. Each bound value is referred to by its 1-based position in the SQL, which PostgreSQL writes as a dollar sign followed by the number. The `parameters` array holds the values in that same order.

Worked example, a saved query bound to one service:

```json
{"sql":"SELECT ... WHERE service=$1","parameters":[{{service}}]}
```

Here the first position is the service. The `{{service}}` placeholder is unquoted, so it stays a bare placeholder in the JSON rather than a string literal.

Dashboard range values are bound the same way: `{"range":"start"}` and `{"range":"end"}` go in `parameters`, and the SQL refers to them by position. Never interpolate values into SQL.
