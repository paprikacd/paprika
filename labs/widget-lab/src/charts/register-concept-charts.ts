import { registerDistributedCharts } from './distributed/register';
import { registerKubernetesCharts } from './kubernetes/register';
import { registerPerformanceCharts } from './performance/register';
import { registerEnergyCharts } from './energy/register';
import { registerClinicalCharts } from './clinical/register';
import { registerWaferCharts } from './wafer/register';
import { registerOrbitalCharts } from './orbital/register';
import { registerLabCharts } from './register-lab-charts';
import { registerMarketCharts } from './market-risk/register';
import { registerInferenceCharts } from './inference/register';
import { registerIncidentCharts } from './incident/register';
import { registerGridCharts } from './grid/register';
import { registerAnalyticsCharts } from './analytics/register';
import { registerSpatialCharts } from './spatial/register';
import { registerExplorationCharts } from './exploration/register';
import { registerProfilingCharts } from './profiling/register';

/** A clean chart-library entry installs every concept family without visiting its lens. */
export function registerConceptCharts() {
  registerLabCharts();
  registerMarketCharts();
  registerInferenceCharts();
  registerIncidentCharts();
  registerGridCharts();
  registerAnalyticsCharts();
  registerSpatialCharts();
  registerExplorationCharts();
  registerProfilingCharts();
  registerEnergyCharts();
  registerClinicalCharts();
  registerWaferCharts();
  registerOrbitalCharts();
  registerKubernetesCharts();
  registerPerformanceCharts();
  registerDistributedCharts();
}
