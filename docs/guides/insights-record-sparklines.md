# Record-table history sparklines

The record-table widget can show a miniature history alongside the latest
observation in a row. In **Column presentation**, choose **History sparkline**
for a string result column. That column must contain a JSON array of at most
240 objects with strictly increasing, unique ISO-8601 timestamps and finite
numeric or `null` values, for example:

```json
[{"timestamp":"2026-10-28T12:00:00Z","value":1.2},{"timestamp":"2026-10-28T12:05:00Z","value":null},{"timestamp":"2026-10-28T12:10:00Z","value":1.6}]
```

PostgreSQL queries can return this shape as a scalar string while keeping the
normal record-frame contract. For example, a correlated subquery can provide
the history for each company:

```sql
SELECT c.symbol,
       (SELECT json_agg(json_build_object(
                 'timestamp', to_char(h.observed_at AT TIME ZONE 'UTC',
                                      'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                 'value', h.value)
               ORDER BY h.observed_at)::text
          FROM reporting.company_history AS h
         WHERE h.symbol = c.symbol) AS trend
  FROM reporting.companies AS c;
```

Limit and order the source observations in the query to stay within the
240-point and 16 KiB per-cell bounds. The plotted horizontal positions use
the returned timestamps; `null` values break the line. The visible reading is
the latest observation, including a missing latest value. Empty or malformed
history is identified in the cell. The widget does not invent samples, execute
another query, or sort the raw JSON as if it were a numeric value.

If the records provider does not attach a unit to that column, set **History
unit** on its column style (for example, `%`). The configured unit applies to
that history cell only.
