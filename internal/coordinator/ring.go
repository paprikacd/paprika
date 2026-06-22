package coordinator

import (
	"fmt"
	"hash/fnv"
	"sort"
	"sync"
)

type ringNode struct {
	position uint64
	member   string
}

type Ring struct {
	mu       sync.RWMutex
	nodes    []ringNode
	members  map[string]bool
	replicas int
}

const defaultReplicas = 16

func NewRing(members []string, replicas int) *Ring {
	if replicas < 1 {
		replicas = defaultReplicas
	}
	r := &Ring{
		members:  make(map[string]bool),
		replicas: replicas,
	}
	r.Rebuild(members)
	return r
}

func (r *Ring) Lookup(key string) (string, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if len(r.nodes) == 0 {
		return "", false
	}
	h := hashKey(key)
	idx := sort.Search(len(r.nodes), func(i int) bool {
		return r.nodes[i].position >= h
	})
	if idx == len(r.nodes) {
		idx = 0
	}
	return r.nodes[idx].member, true
}

func (r *Ring) Members() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	m := make([]string, 0, len(r.members))
	for k := range r.members {
		m = append(m, k)
	}
	return m
}

func (r *Ring) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.members)
}

func (r *Ring) Rebuild(members []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	seen := make(map[string]bool, len(members))
	unique := make([]string, 0, len(members))
	for _, m := range members {
		if !seen[m] {
			seen[m] = true
			unique = append(unique, m)
		}
	}
	r.members = make(map[string]bool, len(unique))
	r.nodes = make([]ringNode, 0, len(unique)*r.replicas)
	for _, m := range unique {
		r.members[m] = true
		for i := 0; i < r.replicas; i++ {
			pos := hashMember(m, i)
			r.nodes = append(r.nodes, ringNode{position: pos, member: m})
		}
	}
	sort.Slice(r.nodes, func(i, j int) bool {
		return r.nodes[i].position < r.nodes[j].position
	})
}

func hashKey(key string) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(key))
	return h.Sum64()
}

func hashMember(member string, idx int) uint64 {
	return hashKey(fmt.Sprintf("%s:%d", member, idx))
}
