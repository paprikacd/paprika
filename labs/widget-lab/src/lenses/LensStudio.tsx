import { lazy, Suspense, useState } from 'react';
import { ArrowLeft, FlaskConical } from 'lucide-react';
import { DashboardEditControls, type EditDashboardWidget } from '../components/lab/DashboardWorkbench';
import { registerLabCharts } from '../charts/register-lab-charts';
import theme from '@insights/gamma/gamma-theme.module.css';
import './LensStudio.css';
import type { LensId } from './lens-routes';
import { useLabMotion } from '../components/lab/motion';
import { useGammaScope } from '../components/lab/appearance';
import { StudyLoading } from '../components/lab/StudyLoading';
export type { LensId } from './lens-routes';

// Every direct lens route shares the core renderers and editor alternatives.
// Domain bundles remain lazy; availability must not depend on a catalogue visit.
registerLabCharts();

const FinanceLens = lazy(() => import('./FinanceLens').then(module => ({ default: module.FinanceLens })));
const OperationsLenses = lazy(() => import('./OperationsLenses').then(module => ({ default: module.OperationsLenses })));
const MarketRiskLens = lazy(() => import('./MarketRiskLens').then(module => ({ default: module.MarketRiskLens })));
const InferenceFleetLens = lazy(() => import('./InferenceFleetLens').then(module => ({ default: module.InferenceFleetLens })));
const IncidentRoomLens = lazy(() => import('./IncidentRoomLens').then(module => ({ default: module.IncidentRoomLens })));
const GridOperationsLens = lazy(() => import('./GridOperationsLens').then(module => ({ default: module.GridOperationsLens })));
const QueryAtlasLens=lazy(()=>import('./profiling/QueryAtlasLens').then(module=>({default:module.QueryAtlasLens})));
const JourneyRetentionLens=lazy(()=>import('./analytics/AnalyticsLenses').then(module=>({default:module.JourneyRetentionLens})));
const FactoryQualityLens=lazy(()=>import('./analytics/AnalyticsLenses').then(module=>({default:module.FactoryQualityLens})));
const ExperimentStudioLens=lazy(()=>import('./analytics/AnalyticsLenses').then(module=>({default:module.ExperimentStudioLens})));
const LogisticsLens=lazy(()=>import('./spatial/SpatialLenses').then(module=>({default:module.LogisticsLens})));
const SpectrumLens=lazy(()=>import('./spatial/SpatialLenses').then(module=>({default:module.SpectrumLens})));
const CoastalLens=lazy(()=>import('./spatial/SpatialLenses').then(module=>({default:module.CoastalLens})));
const ThreatHuntLens=lazy(()=>import('./exploration').then(module=>({default:module.ThreatHuntLens})));
const ProductionPlannerLens=lazy(()=>import('./exploration').then(module=>({default:module.ProductionPlannerLens})));
const MaterialsLabLens=lazy(()=>import('./exploration').then(module=>({default:module.MaterialsLabLens})));
const GridBalanceLens=lazy(()=>import('./energy/GridBalanceLens').then(m=>({default:m.GridBalanceLens})));
const TrialEvidenceLens=lazy(()=>import('./clinical/TrialEvidenceLens').then(m=>({default:m.TrialEvidenceLens})));
const WaferIntelligenceLens=lazy(()=>import('./wafer/WaferIntelligenceLens').then(m=>({default:m.WaferIntelligenceLens})));
const OrbitalContactLens=lazy(()=>import('./orbital/OrbitalContactLens').then(m=>({default:m.OrbitalContactLens})));
const KubernetesFleetLens=lazy(()=>import('./kubernetes/KubernetesFleetLens').then(m=>({default:m.KubernetesFleetLens})));
const PerformanceWorkbenchLens=lazy(()=>import('./performance/PerformanceWorkbenchLens').then(m=>({default:m.PerformanceWorkbenchLens})));
const DistributedSystemsLens=lazy(()=>import('./distributed/DistributedSystemsLens').then(m=>({default:m.DistributedSystemsLens})));
const lensComponents={'distributed-systems':DistributedSystemsLens,'kubernetes-fleet':KubernetesFleetLens,'performance-workbench':PerformanceWorkbenchLens,'grid-balance':GridBalanceLens,'trial-evidence':TrialEvidenceLens,'wafer-intelligence':WaferIntelligenceLens,'orbital-contact':OrbitalContactLens,finance:FinanceLens,'market-risk':MarketRiskLens,'inference-fleet':InferenceFleetLens,'incident-room':IncidentRoomLens,'grid-operations':GridOperationsLens,'query-atlas':QueryAtlasLens,'journey-retention':JourneyRetentionLens,'factory-quality':FactoryQualityLens,'experiment-studio':ExperimentStudioLens,'logistics-control':LogisticsLens,'spectrum-observatory':SpectrumLens,'coastal-observatory':CoastalLens,'threat-hunt':ThreatHuntLens,'production-planner':ProductionPlannerLens,'materials-lab':MaterialsLabLens};
export type EditLensWidget = EditDashboardWidget;

export function LensStudio({ lens }: { lens: LensId }) {
  const motion = useLabMotion();
  const scope = useGammaScope();
  const [canvasWidth, setCanvasWidth] = useState('auto');
  const Component=lens==='website'||lens==='infrastructure'?null:lensComponents[lens];
  return <div className={`${theme.scope} obs-app lens-studio`} {...scope}>
    <header className="lens-toolbar" aria-label="Lens presentation">
      <span><FlaskConical size={13}/>Synthetic data</span>
      <DashboardEditControls/>
      <label className="lens-canvas-control"><span>Canvas</span><select aria-label="Lens canvas width" value={canvasWidth} onChange={event => setCanvasWidth(event.target.value)}><option value="auto">Auto width</option><option value="768">Tablet · 768px</option><option value="390">Mobile · 390px</option></select></label>
      <label className="lens-canvas-control"><span>Motion</span><select aria-label="Lens motion preference" value={motion.preference} onChange={event => motion.setPreference(event.target.value as 'auto' | 'reduced')}><option value="auto">Auto{motion.reduced && motion.preference === 'auto' ? ' · system reduced' : ''}</option><option value="reduced">Reduced</option></select></label>
    </header>
    <div className="lens-canvas" data-preview-width={canvasWidth} style={{width:canvasWidth === 'auto' ? '100%' : `min(100%, ${canvasWidth}px)`}}>
    {canvasWidth !== 'auto' && <div className="lens-canvas-caption">{canvasWidth}px layout preview<button onClick={() => setCanvasWidth('auto')}>Return to auto</button></div>}
    <Suspense fallback={<StudyLoading label={`Loading ${lens.replaceAll('-', ' ')} lens`}/> }>
      {Component?<Component/>:<OperationsLenses kind={lens as 'website'|'infrastructure'}/>}
    </Suspense>
    </div>
    <footer className="lens-studio-footer"><a href="#edge"><ArrowLeft size={12}/>Edge Watch & Reliability Room</a><span>Local design studies · source data and query scope stay explicit</span></footer>
  </div>;
}
