package catalog

import "github.com/benebsworth/paprika/internal/observabilitygateway/connector"

func shortedProvider() TypeInfo {
	return TypeInfo{
		Type: connector.ProviderShorted, DisplayName: "Shorted", Vendor: vendorOpenSource, Category: categoryApplication,
		Signals:     []connector.Signal{connector.SignalMetrics, connector.SignalRecords},
		Summary:     "Read Shorted market, stock and industry application data.",
		Description: "Allowlisted read-only Connect operations return typed records. JSON queries specify operation, typed args and an explicit numeric projection for metrics. Stock/market history preserves source timestamps; current inventory does not invent history. Endpoints and credentials are provider configuration, never query inputs.",
		ConfigFields: []Field{
			{Key: "endpoint", Label: "Shorted API origin", Input: "string", Required: true, Placeholder: "https://shorted-api.example.com", Help: "Absolute API origin without a path. Fixed Shorted Connect read procedures are appended."},
			{Key: "marketDataEndpoint", Label: "Market data API origin", Input: "string", Placeholder: "https://market-data.example.com", Help: "Optional separate origin for market quotes, price history and correlations. No fallback to another endpoint."},
		},
		Credential: CredentialInfo{Kind: "json", Help: "Optional Secret JSON with apiToken, marketDataToken and adminToken. Public and market bearers are sent only to their corresponding endpoint. Protected administrative reads require a separate adminToken, sent only to the fixed read-only GET paths; public tokens are never a fallback. Label the referenced Secret observability.paprika.io/credentials=true. Anonymous public reads are allowed when the source permits them."},
		Steps: []Step{
			{Title: "Configure API origins", Body: "Use your Shorted API origin and optional market data origin. Public sample dashboards and live provider reads are distinct."},
			{Title: "Reference credentials when required", Body: "Store apiToken, marketDataToken and any separately authorized adminToken only in a labelled credential Secret. Configure credentialsSecretRef; never put bearer tokens in query text. The admin credential grants only the adapter's fixed administrative reads, not job execution or cache changes."},
			{Title: "Read a small record sample", Body: "Use query_records with the provider reference and the JSON query below. Metrics require an explicit numeric projection.", Code: `{"operation":"top_shorts","args":{"limit":1}}`},
		},
		Probe: Probe{Signal: connector.SignalRecords, Note: "Read one top-shorts record through GetTopShorts; a successful empty result is valid."},
	}
}

func uptimeProvider() TypeInfo {
	return TypeInfo{
		Type: connector.ProviderUptime, DisplayName: "Uptime", Vendor: vendorOpenSource, Category: categoryApplication,
		Signals:     []connector.Signal{connector.SignalMetrics, connector.SignalRecords},
		Summary:     "Read organization-scoped Uptime inventory, SLOs and stored reliability insights.",
		Description: "Read-only JSON operations cover overview, services, checks, security summaries, triggered alerts, SLOs and existing reliability reports. The provider pins one organization. No generation or management operations are exposed. Missing values and incomplete inventory counts remain explicit; metric projections do not invent history.",
		ConfigFields: []Field{
			{Key: "endpoint", Label: "Uptime API endpoint", Input: "string", Required: true, Placeholder: "https://uptime-api.example.com", Help: "Absolute API endpoint; a base path is allowed. Redirects are refused."},
			{Key: "orgId", Label: "Organization ID", Input: "string", Required: true, Placeholder: "11111111-1111-4111-8111-111111111111", Help: "UUID of the one organization this provider may query. Query arguments cannot override it."},
		},
		Credential: CredentialInfo{Kind: "json", Help: "Required labelled Secret containing a raw bearer or Firebase JSON {apiKey,refreshToken}. The connector refreshes only at Google's fixed verified HTTPS endpoint; no refresh credential reaches Uptime. The identity must have organization membership. Project-token access must be verified separately; no anonymous fallback."},
		Steps: []Step{
			{Title: "Select the organization", Body: "Set the Uptime API endpoint and the organization's UUID. Provider access is additionally controlled by Paprika RBAC."},
			{Title: "Reference an authorized credential", Body: "For durable Firebase access, store {apiKey,refreshToken} from an existing authorized login in a Secret labelled observability.paprika.io/credentials=true and set credentialsSecretRef. A raw bearer remains supported. Do not copy tokens into provider config or dashboards."},
			{Title: "Verify a bounded read", Body: "Use query_records with the query below. For SLO metrics, project uptime with serviceId as a dimension.", Code: `{"operation":"services","args":{"limit":1}}`},
		},
		Probe: Probe{Signal: connector.SignalRecords, Note: "ListServices with pageSize 1 verifies endpoint access and organization membership."},
	}
}

func postgresqlProvider() TypeInfo {
	return TypeInfo{
		Type: connector.ProviderPostgreSQL, DisplayName: "PostgreSQL", Vendor: vendorOpenSource, Category: categoryApplication,
		Signals:     []connector.Signal{connector.SignalMetrics, connector.SignalRecords},
		Summary:     "Query approved PostgreSQL data with a constrained reader role.",
		Description: "Runs a single SELECT in a read-only transaction with fixed statement and lock timeouts, an unprivileged reader-role check, a bounded row limit and typed scalar results. SQL privileges define accessible data. The parameters array accepts {\"range\":\"start\"} and {\"range\":\"end\"} to bind query-range boundaries as UTC timestamps; SQL comparison operators determine inclusivity. Metrics use an explicit projection or the connector's limited numeric/time inference. No connection strings or credentials are accepted in queries.",
		ConfigFields: []Field{
			{Key: "host", Label: "Host", Input: "string", Required: true, Placeholder: "database.example.com", Help: "Database hostname or IP only; no URI, userinfo or connection options."},
			{Key: "port", Label: "Port", Input: "number", Placeholder: "5432", Help: "TCP port, default 5432."},
			{Key: "database", Label: "Database", Input: "string", Required: true, Placeholder: "analytics", Help: "Database name accessible by the dedicated reader role."},
			{Key: "sslmode", Label: "TLS mode", Input: "string", Placeholder: "verify-full", Help: "verify-full is required for remote databases. disable is limited to loopback test servers."},
		},
		Credential: CredentialInfo{Kind: "json", Help: "Required Secret JSON containing only username and password for an unprivileged reader role. Label the Secret observability.paprika.io/credentials=true. The role must not have superuser, role/database creation, replication or RLS bypass privileges."},
		Steps: []Step{
			{Title: "Create a dedicated reader", Body: "Grant SELECT only on approved tables or views. Remove privileged role membership and write-capable function execution; SQL privileges remain the data boundary."},
			{Title: "Configure verified TLS and Secret reference", Body: "Set host, port and database, keep verify-full TLS, and reference a labelled Secret containing the reader username/password. Never put credentials in provider config."},
			{Title: "Verify a small read", Body: "Run query_records with SELECT 1 AS value, then query an approved view with an explicit LIMIT. Add a numeric projection when requesting metrics.", Code: "SELECT 1 AS value"},
		},
		Probe: Probe{Signal: connector.SignalRecords, Note: "SELECT 1 AS value inside the connector's bounded read-only transaction and reader-role checks."},
	}
}
