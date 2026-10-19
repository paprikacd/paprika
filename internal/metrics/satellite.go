package metrics

var (
	SatelliteReports        = mustCounter(meter, "paprika.satellite.reports", "Satellite inventory reports by outcome")
	SatelliteReportDuration = mustFloatHistogram(meter, "paprika.satellite.report.duration", "s", "Time to accept a satellite inventory report")
	SatelliteReportBytes    = mustHistogram(meter, "paprika.satellite.report.bytes", "By", "Uncompressed accepted satellite report size")
)
