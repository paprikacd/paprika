import { lazy, Suspense, useEffect, useState } from 'react';
import { ArrowLeft, ArrowUpRight, BookOpen, ChevronRight, FlaskConical, LayoutDashboard, Maximize2, Minimize2, Moon, Network, Pause, Play, ShieldCheck, Sun } from 'lucide-react';
import { GammaButton } from './vendor/paprika/ui/src/features/insights/gamma/button';
import { labMotionStyle, MotionProvider, useLabMotion } from './components/lab/motion';
import { StudyLoading } from './components/lab/StudyLoading';
import { LabWidgetLoadingProvider } from './components/lab/WidgetLoading';
import { DashboardNavigation } from './components/DashboardNavigation';
import gammaTheme from './vendor/paprika/ui/src/features/insights/gamma/gamma-theme.module.css';
import './observatory.css';
import { isLensRoute } from './lenses/lens-routes';

const EdgeWatch = lazy(() => import('./studies/EdgeWatch').then(module => ({ default: module.EdgeWatch })));
const ReliabilityRoom = lazy(() => import('./studies/ReliabilityRoom').then(module => ({ default: module.ReliabilityRoom })));
const ReferenceStudio = lazy(() => import('./reference/ReferenceStudio').then(module => ({ default: module.ReferenceStudio })));
const LensStudio = lazy(() => import('./lenses/LensStudio').then(module => ({ default: module.LensStudio })));
const ChartCatalog = lazy(() => import('./catalog/ChartCatalog').then(module => ({ default: module.ChartCatalog })));
const BaselineApp = lazy(() => import('./BaselineApp').then(module => ({ default: module.BaselineApp })));
type Study = 'edge' | 'reliability' | 'baseline';
function currentStudy(): Study { return location.hash === '#lab-reliability' ? 'reliability' : location.hash === '#baseline' ? 'baseline' : 'edge'; }

function PaprikaMark() {
  return <svg viewBox="0 0 26 32" fill="none" aria-hidden="true"><path d="M15 2c2 2 2 5 0 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M14 7c7 1 10 5 8 11-2 6-9 7-13 13-1-7-7-10-6-16 1-5 6-8 11-8Z" fill="currentColor"/><path d="m12 9 5 13" stroke="var(--gamma-page)" strokeWidth="2.1" strokeLinecap="round"/></svg>;
}

export function App() {
  const [route,setRoute] = useState(location.hash);
  useEffect(() => { const update=()=>setRoute(location.hash); window.addEventListener('hashchange',update); return()=>window.removeEventListener('hashchange',update); }, []);
  return <MotionProvider><LabWidgetLoadingProvider><DashboardNavigation route={route}/>{isLensRoute(route) ? <Suspense fallback={<StudyLoading label="Loading dashboard lens"/>}><LensStudio key={route} lens={route.slice(1) as import('./lenses/LensStudio').LensId}/></Suspense> : route === '#charts' ? <Suspense fallback={<StudyLoading label="Loading chart library" variant="bars"/>}><ChartCatalog /></Suspense> : route.startsWith('#lab-') || route === '#baseline' ? <Observatory /> : <Suspense fallback={<StudyLoading label="Loading reference study"/>}><ReferenceStudio /></Suspense>}</LabWidgetLoadingProvider></MotionProvider>;
}

function Observatory() {
  const [study, setStudy] = useState<Study>(currentStudy);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [narrow, setNarrow] = useState(false);
  const [guide, setGuide] = useState(false);
  const motion = useLabMotion();
  // Inline tokens deliberately change with the effective preference: Gamma's
  // portal inheritance observes this style attribute while inspectors are open.
  const motionStyle = labMotionStyle(motion.reduced);
  useEffect(() => { const change = () => { if (!['#lab-edge', '#lab-reliability', '#baseline'].includes(location.hash)) return; setStudy(currentStudy()); setGuide(false); }; window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  if (study === 'baseline') return <>
    <div className="baseline-return"><a href="#lab-edge"><ArrowLeft size={15} />Back to new studies</a><span>Iteration 01 · original widget lab</span></div>
    <Suspense fallback={<StudyLoading label="Loading original lab"/>}><BaselineApp /></Suspense>
  </>;
  return <div className={`${gammaTheme.scope} obs-app`} data-insights-theme={theme} data-motion={motion.reduced ? 'reduced' : 'auto'} data-motion-preference={motion.preference} style={motionStyle}>
    <a className="skip-link" href="#study-content" onClick={event => { event.preventDefault(); const main = document.getElementById('study-content'); main?.focus(); main?.scrollIntoView({ block: 'start' }); }}>Skip to widgets</a>
    <aside className="obs-rail" aria-label="Study navigation">
      <a className="obs-mark" href="#lab-edge" aria-label="Paprika Widget Lab"><PaprikaMark /></a>
      <nav>
        <a href="#lab-edge" aria-label="Edge Watch" title="Edge Watch" aria-current={study === 'edge' ? 'page' : undefined}><Network size={20}/></a>
        <a href="#lab-reliability" aria-label="Reliability Room" title="Reliability Room" aria-current={study === 'reliability' ? 'page' : undefined}><ShieldCheck size={20}/></a>
        <a href="#baseline" aria-label="Original widget lab" title="Original widget lab"><LayoutDashboard size={19}/></a>
      </nav>
      <a className="rail-reference" href="https://chatgpt.com/space/page_6ae45780924881918c18270064f72c2c" target="_blank" rel="noreferrer" aria-label="Open dashboard design references" title="Design references"><BookOpen size={18}/></a>
    </aside>
    <div className="obs-main">
      <header className="obs-topbar">
        <div className="obs-brand"><span>paprika</span><ChevronRight size={13}/><strong>Widget lab</strong><span className="study-number">{study === 'edge' ? '02' : '03'}</span></div>
        <nav className="obs-study-tabs" aria-label="Dashboard studies"><a href="#lab-edge" aria-current={study === 'edge' ? 'page' : undefined}>Edge Watch</a><a href="#lab-reliability" aria-current={study === 'reliability' ? 'page' : undefined}>Reliability Room</a></nav>
        <div className="obs-top-actions">
          <span className="obs-fixture-label"><FlaskConical size={13}/>Synthetic data</span>
          {motion.hasReplay && <GammaButton size="sm" variant={motion.replaying ? 'secondary' : 'ghost'} aria-label={motion.replaying ? 'Pause demo replay' : 'Start demo replay'} aria-pressed={motion.replaying} onClick={motion.toggleReplay} title="Advance the synthetic snapshot every 1.8 seconds. Pauses when the tab is hidden.">{motion.replaying ? <Pause size={13}/> : <Play size={13}/>}Demo replay</GammaButton>}
          <GammaButton size="sm" variant="ghost" aria-label={motion.preference === 'reduced' ? 'Use automatic motion' : 'Reduce motion'} aria-pressed={motion.preference === 'reduced'} onClick={() => motion.setPreference(motion.preference === 'reduced' ? 'auto' : 'reduced')} title={motion.preference === 'auto' && motion.reduced ? 'Automatic motion is reduced by your operating system preference.' : 'Auto follows your operating system preference. Reduced removes decorative motion.'}>Motion {motion.preference === 'reduced' ? 'Reduced' : 'Auto'}</GammaButton>
          <GammaButton size="sm" variant="ghost" iconOnly aria-label={narrow ? 'Use wide canvas' : 'Use narrow canvas'} aria-pressed={narrow} onClick={() => setNarrow(!narrow)}>{narrow ? <Maximize2 size={16}/> : <Minimize2 size={16}/>}</GammaButton>
          <GammaButton size="sm" variant="ghost" iconOnly aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={16}/> : <Moon size={16}/>}</GammaButton>
          <GammaButton size="sm" variant="ghost" iconOnly aria-label="Evaluation notes" aria-expanded={guide} onClick={() => setGuide(!guide)}><BookOpen size={16}/></GammaButton>
        </div>
      </header>
      {guide && <section className="obs-guide" aria-label="Evaluation notes"><div><strong>Two studies, one design system</strong><p>Compare the compact metrics, ranked tables and rich chart inspectors with the Edge Watch and Reliability Room references. All telemetry is deterministic and synthetic.</p></div><div><strong>Try the edges</strong><p>Inspect with arrow keys and Enter, then advance the snapshot or start Demo replay. Changed metrics receive one brief emphasis; their values update immediately. Reduced motion preserves the same observations and replay cadence. Use panel information buttons for units, interval conventions and accounting details.</p></div><a href="https://chatgpt.com/space/page_6ae45839b6b88191acaffee32e79ef34" target="_blank" rel="noreferrer">Open visual references<ArrowUpRight size={14}/></a></section>}
      <main className={`obs-canvas ${narrow ? 'obs-canvas-narrow' : ''}`} id="study-content" tabIndex={-1}>
        <Suspense fallback={<StudyLoading label="Loading study"/>}>
          {study === 'edge' ? <EdgeWatch theme={theme} narrow={narrow}/> : <ReliabilityRoom theme={theme} narrow={narrow}/>}
        </Suspense>
      </main>
      <footer className="obs-footer"><span><FlaskConical size={12}/>Dashboard studies · concept telemetry</span><a href="#baseline">Compare original lab<ArrowUpRight size={12}/></a><span className="obs-footer-brand"><PaprikaMark/>Paprika</span></footer>
    </div>
  </div>;
}
