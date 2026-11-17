"""Advance the synthetic exporter from the end of backfill to real time.

During bootstrap, each scrape emits at most one past minute of generated data.
The ordinary exporter resumes wall-clock scrapes once the gap is filled.
"""


class SampleClock:
    def __init__(self, latest):
        self.latest = latest
        self.complete = latest is None

    def next(self, now):
        if self.complete:
            return now, True
        if now <= self.latest:
            # A generator clock ahead of the host cannot safely be caught up.
            raise ValueError("synthetic history ends at or after the current time")
        self.latest = min(self.latest + 60, now)
        self.complete = self.latest == now
        return self.latest, self.complete
