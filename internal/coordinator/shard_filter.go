package coordinator

import (
	"github.com/benebsworth/paprika/internal/sharding"
)

type RingShardFilter struct {
	ring *Ring
	self string
}

func NewRingShardFilter(ring *Ring, self string) *RingShardFilter {
	return &RingShardFilter{ring: ring, self: self}
}

func (f *RingShardFilter) Matches(namespace string) bool {
	if f.ring == nil || f.ring.Len() == 0 {
		return true
	}
	owner, ok := f.ring.Lookup(namespace)
	if !ok {
		return true
	}
	return owner == f.self
}

var _ sharding.Matcher = (*RingShardFilter)(nil)
