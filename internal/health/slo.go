package health

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// SLOSummary separates measured availability from coverage of the requested
// window. A new or interrupted monitor cannot claim that unobserved time was up.
type SLOSummary struct {
	State                                                                     string
	Target, Availability, Coverage, WindowCoverage, BudgetRemaining, BurnRate float64
	WindowSeconds, IntervalSeconds, Healthy, Unhealthy, Unknown, Expected     int64
	FirstObservedAt, LastObservedAt                                           time.Time
	Timeline                                                                  []SLOBucket
}

type SLOBucket struct {
	Start                       time.Time
	Healthy, Unhealthy, Unknown int64
}

func SLODurations(check api.HealthCheck) (window, interval time.Duration, err error) {
	if check.SLO == nil {
		return 0, 0, errors.New("no SLO configured")
	}
	window = map[string]time.Duration{"1h": time.Hour, "24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour, "30d": 30 * 24 * time.Hour}[check.SLO.Window]
	interval = 30 * time.Second
	if check.Interval != "" {
		interval, err = time.ParseDuration(check.Interval)
	}
	if err != nil || !validSLOInterval(window, interval) {
		return 0, 0, errors.New("SLO interval must be 10s–1h in whole seconds and divide the window (1h, 24h, 7d, 30d)")
	}
	target := check.SLO.TargetPercentage
	if math.IsNaN(target) || target < 1 || target > 99.9999 {
		return 0, 0, errors.New("SLO targetPercentage must be between 1 and 99.9999")
	}
	if err = validateSLOProbe(check.HTTPProbe, interval); err != nil {
		return 0, 0, err
	}
	return window, interval, nil
}

func validSLOInterval(window, interval time.Duration) bool {
	return window > 0 && interval >= 10*time.Second && interval <= time.Hour && interval%time.Second == 0 && window%interval == 0
}

func validateSLOProbe(p *api.HTTPProbe, interval time.Duration) error {
	if p == nil || !SafeOperationalURL(p.URL) {
		return errors.New("SLO requires an HTTP(S) probe without URL credentials")
	}
	if p.Method != "" && p.Method != http.MethodGet && p.Method != http.MethodHead {
		return errors.New("SLO probe method must be GET or HEAD")
	}
	if p.Timeout < 0 || p.Timeout > 30 || time.Duration(p.Timeout)*time.Second > interval {
		return errors.New("SLO timeout must not exceed 30 seconds or its interval")
	}
	return nil
}

// SafeOperationalURL is also applied on reads, since webhooks may be disabled.
func SafeOperationalURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Hostname() != "" && u.User == nil && !strings.ContainsAny(raw, "\r\n\t ")
}

// MeasurementHash excludes only the target: changing a budget reuses evidence;
// changing the probe, interval or window starts a new, explicitly partial history.
func MeasurementHash(check api.HealthCheck) string {
	if check.SLO != nil {
		copySLO := *check.SLO
		copySLO.TargetPercentage = 0
		check.SLO = &copySLO
	}
	b, err := json.Marshal(check)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func slotCode(samples []byte, slot, count int64) byte {
	i := slot % count
	return (samples[i/4] >> ((i % 4) * 2)) & 3
}

func putSlot(samples []byte, slot, count int64, code byte) {
	i := slot % count
	shift := (i % 4) * 2
	samples[i/4] = (samples[i/4] & ^(byte(3) << shift)) | code<<shift
}

// RecordSLO counts at most one actual observation per scheduled slot. Gaps are
// cleared, never backfilled; a full-window outage of the monitor clears the ring.
func RecordSLO(check api.HealthCheck, previous *api.SLOHistory, status api.HealthStatus, now time.Time) *api.SLOHistory {
	window, interval, err := SLODurations(check)
	if err != nil {
		return nil
	}
	count, slot := int64(window/interval), now.Unix()/int64(interval/time.Second)
	if slot < 0 {
		return nil
	}
	hash := MeasurementHash(check)
	size := int((count + 3) / 4)
	h := previous
	if h == nil || h.ConfigurationHash != hash || len(h.Samples) != size {
		h = &api.SLOHistory{ConfigurationHash: hash, FirstObservedAt: metav1.NewTime(now), LastSlot: slot - 1, Samples: make([]byte, size)}
	} else {
		h = h.DeepCopy()
	}
	if slot <= h.LastSlot {
		return h
	}
	start := h.LastSlot + 1
	if slot-start >= count {
		start = slot - count + 1
	}
	for s := start; s <= slot; s++ {
		putSlot(h.Samples, s, count, 0)
	}
	putSlot(h.Samples, slot, count, sloStatusCode(status))
	h.LastSlot = slot
	return h
}

func SummarizeSLO(check api.HealthCheck, h *api.SLOHistory, now time.Time) SLOSummary {
	result := SLOSummary{State: "Collecting"}
	window, interval, err := SLODurations(check)
	if err != nil {
		result.State = "Invalid"
		return result
	}
	result.Target = check.SLO.TargetPercentage
	result.WindowSeconds = int64(window / time.Second)
	result.IntervalSeconds = int64(interval / time.Second)
	count := int64(window / interval)
	result.Expected = count
	result.BudgetRemaining = 100
	if h == nil || h.ConfigurationHash != MeasurementHash(check) || len(h.Samples) != int((count+3)/4) {
		return result
	}
	result.FirstObservedAt = h.FirstObservedAt.Time
	result.LastObservedAt = time.Unix(h.LastSlot*result.IntervalSeconds, 0).UTC()
	slot := now.Unix() / result.IntervalSeconds
	if slot < h.LastSlot {
		result.State = "Unknown"
		return result
	}
	first := max(slot-count+1, h.FirstObservedAt.Unix()/result.IntervalSeconds)
	summarizeSLOSlots(&result, h, first, slot, count)
	observed := result.Healthy + result.Unhealthy
	if observed > 0 {
		result.Availability = 100 * float64(result.Healthy) / float64(observed)
		result.BurnRate = (1 - result.Availability/100) / (1 - result.Target/100)
	}
	result.Coverage = 100 * float64(observed) / float64(max(int64(1), slot-first+1))
	result.WindowCoverage = 100 * float64(observed) / float64(count)
	allowance := float64(count) * (1 - result.Target/100)
	result.BudgetRemaining = 100 * (1 - float64(result.Unhealthy)/allowance)
	result.State = sloState(&result, now, window, interval, count, allowance)
	return result
}

func summarizeSLOSlots(result *SLOSummary, h *api.SLOHistory, first, slot, count int64) {
	// At most 61 timeline buckets are returned to the UI, independent of the
	// probe frequency. Their counts remain exact; only visual grouping changes.
	width := max(int64(1), (count+59)/60)
	for s := first; s <= slot; s++ {
		code := byte(0)
		if s <= h.LastSlot && s > h.LastSlot-count {
			code = slotCode(h.Samples, s, count)
		}
		bucketStart := time.Unix((s/width)*width*result.IntervalSeconds, 0).UTC()
		if len(result.Timeline) == 0 || !result.Timeline[len(result.Timeline)-1].Start.Equal(bucketStart) {
			result.Timeline = append(result.Timeline, SLOBucket{Start: bucketStart})
		}
		b := &result.Timeline[len(result.Timeline)-1]
		switch code {
		case 1:
			result.Healthy++
			b.Healthy++
		case 2:
			result.Unhealthy++
			b.Unhealthy++
		default:
			result.Unknown++
			b.Unknown++
		}
	}
}

func sloState(s *SLOSummary, now time.Time, window, interval time.Duration, count int64, allowance float64) string {
	switch {
	case now.Sub(s.LastObservedAt) > 2*interval:
		return "Stale"
	case now.Sub(s.FirstObservedAt) < window:
		return "Collecting"
	case float64(s.Unhealthy) > allowance:
		return "Breached"
	case float64(s.Healthy)/float64(count) >= s.Target/100:
		return "Met"
	default:
		return "InsufficientData"
	}
}

func sloStatusCode(status api.HealthStatus) byte {
	switch status {
	case api.HealthHealthy:
		return 1
	case api.HealthDegraded:
		return 2
	case api.HealthUnknown, api.HealthProgressing:
		return 3
	default:
		return 3
	}
}
