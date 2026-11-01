import { useEffect, useRef } from 'react';
import { ChevronDown, LayoutGrid } from 'lucide-react';
import theme from '@insights/gamma/gamma-theme.module.css';
import { PaprikaMark } from '../reference/ReferenceShared';
import { lensRoutes } from '../lenses/lens-routes';
import './DashboardNavigation.css';

const references = [{ id: 'edge', label: 'Edge Watch', group: 'Reference studies' }, { id: 'reliability', label: 'Reliability Room', group: 'Reference studies' }];
const destinations = [...references, ...lensRoutes, { id: 'charts', label: 'Chart library', group: 'Components' }];
const groups = [...new Set(destinations.map(item => item.group))];

/** One route catalogue drives every navigation surface, including narrow screens. */
export function DashboardNavigation({ route }: { route: string }) {
  const current = route === '#lab-edge' || route === '' ? '#edge' : route === '#lab-reliability' ? '#reliability' : route;
  const menu = useRef<HTMLDetailsElement>(null), trigger = useRef<HTMLElement>(null);
  useEffect(() => { if (menu.current) menu.current.open = false; }, [current]);
  const active = destinations.find(item => `#${item.id}` === current);
  const activeGroup = active?.group === 'Domain studies' ? 'Domain studies' : active?.group === 'Core' ? 'Core' : 'SRE investigations';
  const shortcuts = destinations.filter(item => item.group === activeGroup).slice(0, 4);
  return <header className={`${theme.scope} dashboard-navigation`} data-insights-theme="dark">
    <a className="dashboard-navigation-brand" href="#edge" aria-label="Paprika Widget Lab home"><PaprikaMark/><span>paprika <span>/ widget lab</span></span></a>
    <label className="dashboard-navigation-picker"><span>{lensRoutes.length + references.length} lenses</span><select aria-label="Choose dashboard lens" value={active ? current : '#edge'} onChange={event => { location.hash = event.target.value; }}>{groups.map(group => <optgroup key={group} label={group}>{destinations.filter(item => item.group === group).map(item => <option key={item.id} value={`#${item.id}`}>{item.label}</option>)}</optgroup>)}</select></label>
    <nav className="dashboard-navigation-shortcuts" aria-label="Related dashboard lenses">{shortcuts.map(item => <a key={item.id} href={`#${item.id}`} aria-current={current === `#${item.id}` ? 'page' : undefined}>{item.label}</a>)}</nav>
    <details ref={menu} className="dashboard-navigation-menu" onKeyDown={event => { if (event.key === 'Escape' && menu.current?.open) { event.preventDefault(); menu.current.open = false; trigger.current?.focus(); } }}>
      <summary ref={trigger}><LayoutGrid size={15}/><span>All lenses</span><ChevronDown size={13}/></summary>
      <nav className="dashboard-navigation-directory" aria-label="All dashboard lenses">{groups.map(group => <section key={group}><h2>{group}</h2>{destinations.filter(item => item.group === group).map(item => <a key={item.id} href={`#${item.id}`} aria-current={current === `#${item.id}` ? 'page' : undefined} onClick={() => { if (menu.current) menu.current.open = false; }}>{item.label}</a>)}</section>)}</nav>
    </details>
  </header>;
}
