// Package vultrmonitoring implements connector.Connector for Vultr's
// monitoring surface — the v2 API bandwidth endpoints. Only the metrics
// signal is served, and queries carry the metric name, the same convention
// the CloudWatch metrics connector uses: the metric selects which native
// endpoint answers, and the backend's own window (the current billing
// period) is returned untouched — the v2 API accepts no time-range
// parameters, so QueryRequest.Range is not sent.
//
// Three metrics exist. "account_bandwidth" is GET /v2/account/bandwidth:
// previous-month, current-month-to-date and projected periods with GB in/out
// and overage. "instance_bandwidth_incoming_bytes" and
// "instance_bandwidth_outgoing_bytes" fan out across every cloud-compute
// instance (GET /v2/instances, cursor-paginated) reading each instance's
// GET /v2/instances/{id}/bandwidth daily points, and assemble one series
// per instance, tagged by instance ID and label. Per-instance failures are
// omitted from the series and counted under "partial" rather than failing
// the fleet query; the instance-list failure still fails the whole call.
//
// An empty Query is the probe path: the account bandwidth endpoint, the
// cheapest read the API offers. Credentials are a raw Vultr API key
// (sent as an Authorization: Bearer token); an absent key reports
// StateNotConfigured — Vultr has no ambient identity chain.
package vultrmonitoring

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

// Vultr v2 API paths, default endpoint and fan-out bounds. Instance listing
// is cursor-paginated; the caps keep one query bounded on accounts with
// many instances.
const (
	defaultEndpoint       = "https://api.vultr.com"
	pathAccountBandwidth  = "/v2/account/bandwidth"
	pathInstances         = "/v2/instances"
	pathInstanceBandwidth = "/v2/instances/%s/bandwidth" // one fmt slot: the instance ID
	perPage               = 100
	maxListPages          = 10
	maxFanoutInstances    = 100
	fanoutConcurrency     = 8
)

// Metric names the connector serves, in Query argument form.
const (
	MetricAccountBandwidth      = "account_bandwidth"
	MetricInstanceIncomingBytes = "instance_bandwidth_incoming_bytes"
	MetricInstanceOutgoingBytes = "instance_bandwidth_outgoing_bytes"
	directionIncoming           = "incoming_bytes"
	directionOutgoing           = "outgoing_bytes"
)

// VultrMonitoring is a connector for the Vultr monitoring API. It is a
// stateless struct; per-call state travels in connector.QueryRequest.
type VultrMonitoring struct{}

// New returns a Vultr monitoring connector.
func New() connector.Connector { return VultrMonitoring{} }

// Descriptor advertises name, signals and network needs.
func (VultrMonitoring) Descriptor() connector.Descriptor {
	return connector.Descriptor{
		Name:        connector.ProviderVultrMonitoring,
		Signals:     []connector.Signal{connector.SignalMetrics},
		NeedsEgress: true,
	}
}

// ValidateConfig checks the strict connector configuration — the optional
// endpoint override (the vendor API is the default), plus the optional
// headers and insecureSkipTLS keys — ahead of use.
func (VultrMonitoring) ValidateConfig(config json.RawMessage) error {
	if _, err := parseConfig(config); err != nil {
		return fmt.Errorf("validate config: %w", err)
	}
	return nil
}

// Query runs one metric lookup. An empty Query is the probe: the account
// bandwidth endpoint. The metric name is validated before configuration,
// mirroring the shape-before-config contract of the other connectors.
//
//nolint:gocritic // QueryRequest travels by value by design — per-call state belongs in the request, not the connector (clusterprovider contract).
func (v VultrMonitoring) Query(ctx context.Context, req connector.QueryRequest) (*connector.QueryResult, error) {
	if req.Signal != connector.SignalMetrics {
		return unsupported("vultr-monitoring connector supplies metrics only")
	}
	if req.Query == "" {
		return v.probe(ctx, req)
	}
	var direction string
	switch req.Query {
	case MetricAccountBandwidth:
		return v.accountBandwidth(ctx, req)
	case MetricInstanceIncomingBytes:
		direction = directionIncoming
	case MetricInstanceOutgoingBytes:
		direction = directionOutgoing
	default:
		return unsupported(fmt.Sprintf("metric %q is not served by the vultr-monitoring connector", req.Query))
	}
	return queryInstanceBandwidth(ctx, &req, direction)
}

func queryInstanceBandwidth(ctx context.Context, req *connector.QueryRequest, direction string) (*connector.QueryResult, error) {
	cfg, err := parseConfig(req.Config)
	if err != nil {
		return nil, fmt.Errorf("vultr-monitoring: %w", err)
	}
	if len(req.Credentials) == 0 {
		return notConfigured(), nil
	}
	instances, err := listInstances(ctx, cfg, req.Credentials)
	if err != nil {
		return queryError(err), nil
	}
	series, partial := instanceBandwidthSeries(ctx, cfg, req.Credentials, instances, direction)
	data, err := json.Marshal(struct {
		Series  []instanceSeries `json:"series"`
		Partial int              `json:"partial"`
	}{Series: series, Partial: partial})
	if err != nil {
		return &connector.QueryResult{State: connector.StateError, Reason: "encoding the query result failed"}, nil
	}
	return &connector.QueryResult{State: connector.StateOK, Data: data}, nil
}

// probe is the empty-Query health path: the account bandwidth endpoint.
//
//nolint:gocritic // QueryRequest travels by value by design.
func (v VultrMonitoring) probe(ctx context.Context, req connector.QueryRequest) (*connector.QueryResult, error) {
	cfg, err := parseConfig(req.Config)
	if err != nil {
		return nil, fmt.Errorf("vultr-monitoring: %w", err)
	}
	if len(req.Credentials) == 0 {
		return notConfigured(), nil
	}
	return v.get(ctx, cfg, req.Credentials, pathAccountBandwidth)
}

// accountBandwidth answers the account_bandwidth metric: the native
// response of GET /v2/account/bandwidth, untouched.
//
//nolint:gocritic // QueryRequest travels by value by design.
func (v VultrMonitoring) accountBandwidth(ctx context.Context, req connector.QueryRequest) (*connector.QueryResult, error) {
	cfg, err := parseConfig(req.Config)
	if err != nil {
		return nil, fmt.Errorf("vultr-monitoring: %w", err)
	}
	if len(req.Credentials) == 0 {
		return notConfigured(), nil
	}
	return v.get(ctx, cfg, req.Credentials, pathAccountBandwidth)
}

// get performs one authenticated GET and returns the native body.
func (VultrMonitoring) get(ctx context.Context, cfg httphelp.Config, credentials []byte, path string) (*connector.QueryResult, error) {
	data, err := httphelp.Get(ctx, cfg, path, nil, credentials)
	if err != nil {
		return queryError(err), nil
	}
	return &connector.QueryResult{State: connector.StateOK, Data: data}, nil
}

// instance is the slice of GET /v2/instances the connector reads; the
// bandwidth series are tagged by ID and label.
type instance struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Region string `json:"region"`
	Status string `json:"status"`
}

// listResponse is the envelope of every Vultr v2 list endpoint: the
// resource key varies ("instances" here) and the next page is a cursor
// carried in meta.links.next.
type listResponse struct {
	Instances []instance `json:"instances"`
	Meta      struct {
		Links struct {
			Next string `json:"next"`
		} `json:"links"`
	} `json:"meta"`
}

// listInstances walks the cursor pages of GET /v2/instances and returns the
// first maxFanoutInstances instances. A page read failure abandons the walk
// with the error — the assembled view would mislead without the full fleet.
func listInstances(ctx context.Context, cfg httphelp.Config, credentials []byte) ([]instance, error) {
	var out []instance
	cursor := ""
	for page := 0; page < maxListPages; page++ {
		params := url.Values{"per_page": []string{strconv.Itoa(perPage)}}
		if cursor != "" {
			params.Set("cursor", cursor)
		}
		data, err := httphelp.Get(ctx, cfg, pathInstances, params, credentials)
		if err != nil {
			return nil, fmt.Errorf("list Vultr instances: %w", err)
		}
		var body listResponse
		if err := json.Unmarshal(data, &body); err != nil {
			return nil, fmt.Errorf("decoding instances response: %w", err)
		}
		out = append(out, body.Instances...)
		if len(out) >= maxFanoutInstances || body.Meta.Links.Next == "" {
			break
		}
		cursor = body.Meta.Links.Next
	}
	if len(out) > maxFanoutInstances {
		out = out[:maxFanoutInstances]
	}
	return out, nil
}

// instanceSeries is one assembled series: the instance identity plus the
// selected direction's daily points sorted ascending by date.
//
//nolint:tagliatelle // Preserve the existing connector wire format, including instance_id.
type instanceSeries struct {
	InstanceID string          `json:"instance_id"`
	Label      string          `json:"label"`
	Points     [][]interface{} `json:"points"`
}

// bandwidthPoints maps one instance's daily bandwidth by date.
//
//nolint:tagliatelle // Vultr API bandwidth fields use snake_case.
type bandwidthPoints map[string]struct {
	IncomingBytes int64 `json:"incoming_bytes"`
	OutgoingBytes int64 `json:"outgoing_bytes"`
}

// instanceBandwidth fetches one instance's bandwidth and projects the
// requested direction into date-sorted [date, value] points.
func instanceBandwidth(ctx context.Context, cfg httphelp.Config, credentials []byte, id, direction string) ([][]interface{}, error) {
	data, err := httphelp.Get(ctx, cfg, fmt.Sprintf(pathInstanceBandwidth, url.PathEscape(id)), nil, credentials)
	if err != nil {
		return nil, fmt.Errorf("get Vultr instance bandwidth: %w", err)
	}
	var body struct {
		Bandwidth bandwidthPoints `json:"bandwidth"`
	}
	if err := json.Unmarshal(data, &body); err != nil {
		return nil, fmt.Errorf("decoding instance bandwidth response: %w", err)
	}
	dates := make([]string, 0, len(body.Bandwidth))
	for date := range body.Bandwidth {
		dates = append(dates, date)
	}
	sort.Strings(dates)
	points := make([][]interface{}, 0, len(dates))
	for _, date := range dates {
		var value int64
		switch direction {
		case directionIncoming:
			value = body.Bandwidth[date].IncomingBytes
		default:
			value = body.Bandwidth[date].OutgoingBytes
		}
		points = append(points, []interface{}{date, value})
	}
	return points, nil
}

// instanceBandwidthSeries fans out across the instances bounded by
// fanoutConcurrency, omitting instances whose read failed and counting them
// under partial.
func instanceBandwidthSeries(ctx context.Context, cfg httphelp.Config, credentials []byte, instances []instance, direction string) (results []instanceSeries, partialCount int) {
	series := make([]instanceSeries, len(instances))
	var partial atomicCounter
	sem := make(chan struct{}, fanoutConcurrency)
	var wg sync.WaitGroup
	for i, inst := range instances {
		wg.Add(1)
		go func(i int, inst instance) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			points, err := instanceBandwidth(ctx, cfg, credentials, inst.ID, direction)
			if err != nil {
				partial.inc()
				return
			}
			series[i] = instanceSeries{InstanceID: inst.ID, Label: inst.Label, Points: points}
		}(i, inst)
	}
	wg.Wait()
	out := make([]instanceSeries, 0, len(instances))
	for i := range series {
		if series[i].InstanceID != "" {
			out = append(out, series[i])
		}
	}
	return out, partial.load()
}

// atomicCounter counts partial fan-out failures; atomic keeps the race
// detector quiet under the fan-out goroutines.
type atomicCounter struct{ n int32 }

func (c *atomicCounter) inc()      { atomic.AddInt32(&c.n, 1) }
func (c *atomicCounter) load() int { return int(atomic.LoadInt32(&c.n)) }
