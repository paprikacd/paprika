"""Bounded, synthetic parent/child timings for the local Tempo gallery.

Each tuple is (root duration, catalog start/duration, payment start/duration,
database start/duration), in milliseconds. The first is deliberately kept as
the stable 200ms fixture exercised by the browser waterfall tests. Every child
is inside its parent, including the nested database span.
"""

PATTERNS = (
    (200, 10, 60, 75, 80, 20, 28),
    (340, 12, 94, 110, 165, 28, 40),
    (120, 6, 42, 52, 50, 14, 18),
    (520, 18, 145, 178, 260, 47, 72),
    (290, 9, 125, 156, 112, 26, 68),
    (760, 20, 150, 190, 510, 40, 90),
)


def trace_timing(sample, duration_ms=None):
    """Return root and child offset/duration pairs in nanoseconds.

    A requested root duration scales the complete shape, rather than just
    stretching its root, so the bootstrap history retains meaningful child
    timing. Integer arithmetic keeps all spans within their recorded parent.
    """
    base, catalog_at, catalog_len, payment_at, payment_len, db_at, db_len = PATTERNS[sample % len(PATTERNS)]
    duration = base if duration_ms is None else duration_ms
    def scale(value):
        return value * duration * 1_000_000 // base
    return ((0, duration * 1_000_000), (scale(catalog_at), scale(catalog_len)),
            (scale(payment_at), scale(payment_len)), (scale(db_at), scale(db_len)))
