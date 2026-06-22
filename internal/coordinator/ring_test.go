package coordinator

import (
	"fmt"
	"testing"
)

func TestEmptyRing(t *testing.T) {
	r := NewRing(nil, 16)
	_, ok := r.Lookup("any")
	if ok {
		t.Error("expected false for empty ring")
	}
}

func TestSingleMember(t *testing.T) {
	r := NewRing([]string{"a"}, 16)
	for _, ns := range []string{"default", "kube-system", "production", "staging"} {
		owner, ok := r.Lookup(ns)
		if !ok || owner != "a" {
			t.Errorf("expected 'a', got %q (ok=%v)", owner, ok)
		}
	}
}

func TestTwoMembers(t *testing.T) {
	r := NewRing([]string{"a", "b"}, 200)
	counts := map[string]int{"a": 0, "b": 0}
	for i := 0; i < 1000; i++ {
		owner, ok := r.Lookup(fmt.Sprintf("ns-%d", i))
		if !ok {
			t.Fatal("unexpected empty lookup")
		}
		counts[owner]++
	}
	if counts["a"] < 400 || counts["b"] < 400 {
		t.Errorf("distribution too skewed: a=%d, b=%d", counts["a"], counts["b"])
	}
}

func TestMemberRemoval(t *testing.T) {
	r := NewRing([]string{"a", "b", "c"}, 16)
	assignments := make(map[string]string)
	for i := 0; i < 1000; i++ {
		ns := fmt.Sprintf("ns-%d", i)
		owner, _ := r.Lookup(ns)
		assignments[ns] = owner
	}
	r.Rebuild([]string{"a", "b"})
	moved := 0
	for ns, oldOwner := range assignments {
		newOwner, _ := r.Lookup(ns)
		if newOwner != oldOwner {
			moved++
		}
	}
	if moved < 200 || moved > 500 {
		t.Errorf("expected ~333 keys to move, got %d", moved)
	}
}

func TestMemberAddition(t *testing.T) {
	r := NewRing([]string{"a", "b"}, 16)
	assignments := make(map[string]string)
	for i := 0; i < 1000; i++ {
		ns := fmt.Sprintf("ns-%d", i)
		owner, _ := r.Lookup(ns)
		assignments[ns] = owner
	}
	r.Rebuild([]string{"a", "b", "c"})
	moved := 0
	for ns, oldOwner := range assignments {
		newOwner, _ := r.Lookup(ns)
		if newOwner != oldOwner {
			moved++
		}
	}
	if moved < 200 || moved > 500 {
		t.Errorf("expected ~333 keys to move, got %d", moved)
	}
}

func TestDeterministic(t *testing.T) {
	r1 := NewRing([]string{"a", "b", "c"}, 16)
	r2 := NewRing([]string{"a", "b", "c"}, 16)
	for i := 0; i < 100; i++ {
		ns := fmt.Sprintf("ns-%d", i)
		o1, _ := r1.Lookup(ns)
		o2, _ := r2.Lookup(ns)
		if o1 != o2 {
			t.Errorf("mismatch for %s: %s vs %s", ns, o1, o2)
		}
	}
}

func TestCompleteness(t *testing.T) {
	r := NewRing([]string{"a", "b", "c", "d", "e"}, 16)
	for i := 0; i < 1000; i++ {
		_, ok := r.Lookup(fmt.Sprintf("ns-%d", i))
		if !ok {
			t.Fatal("unexpected empty lookup")
		}
	}
}

func TestConcurrentAccess(t *testing.T) {
	r := NewRing([]string{"a", "b", "c"}, 16)
	done := make(chan bool)
	for i := 0; i < 10; i++ {
		go func() {
			for j := 0; j < 100; j++ {
				r.Lookup("default")
			}
			done <- true
		}()
	}
	go func() {
		for j := 0; j < 10; j++ {
			r.Rebuild([]string{"a", "b", "c", "d"})
			r.Rebuild([]string{"a", "b", "c"})
		}
		done <- true
	}()
	for i := 0; i < 11; i++ {
		<-done
	}
}
