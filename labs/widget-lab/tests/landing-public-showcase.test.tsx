// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { lensRoutes } from '../src/lenses/lens-routes';
import { allChartCatalog } from '../src/catalog/chart-fixtures';
const markup = readFileSync('../../landing/index.html','utf8');
const javascript = readFileSync('../../landing/chart-showcase.js','utf8');
describe('public chart showcase',()=>{
  beforeEach(()=>{
    const parsed=new DOMParser().parseFromString(markup,'text/html');
    const iframe=parsed.querySelector('#chart-showcase-frame')!;
    const fake=parsed.createElement('div');
    fake.id='chart-showcase-frame';
    iframe.replaceWith(fake);
    document.body.innerHTML=parsed.body.innerHTML;
    Object.defineProperty(document.getElementById('chart-showcase-frame')!, 'src', {
      value: new URL('./charts/#charts', document.baseURI).href, writable: true, configurable: true,
    });
    window.eval(javascript);
  });
  afterEach(()=>{document.body.innerHTML='';});
  it('exposes the catalogue and five deep-linked previews',()=>{
    expect([...document.querySelectorAll<HTMLElement>('[data-chart-route]')].map(x=>x.dataset.chartRoute))
      .toEqual(['charts','kubernetes-fleet','performance-workbench','finance','distributed-systems']);
    expect(document.querySelector<HTMLIFrameElement>('#chart-showcase-frame')?.src).toContain('/charts/#charts');
  });
  it('synchronizes the preview, active picker and full-screen links',()=>{
    const link=document.querySelector<HTMLAnchorElement>('[data-chart-route="kubernetes-fleet"]')!;
    link.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0}));
    const frame=document.querySelector<HTMLIFrameElement>('#chart-showcase-frame')!;
    expect(frame.src).toContain('/charts/#kubernetes-fleet');
    expect(link.getAttribute('aria-current')).toBe('true');
    expect(document.querySelector('[data-chart-route="charts"]')?.hasAttribute('aria-current')).toBe(false);
    expect(document.querySelector<HTMLAnchorElement>('[data-chart-open]')?.href).toBe(frame.src);
    expect(document.querySelector('[data-chart-caption]')?.textContent).toContain('workload placement');
  });
  it('states counts the gallery serves',()=>{
    const count=(label:string)=>Number(new RegExp(`<strong>(\\d+)\\+?</strong> ${label}`).exec(markup)?.[1]);
    expect(count('dashboard studies')).toBe(lensRoutes.length+2);
    expect(count('chart examples')).toBeLessThanOrEqual(allChartCatalog.length);
  });
  it('labels concept studies and claims no more than the product renders',()=>{
    expect(markup).toContain('Charts marked In Paprika use the product');
    expect(markup).not.toContain("Paprika's real chart renderers");
    for (const route of ['performance-workbench','finance','distributed-systems']) expect(markup).toMatch(new RegExp(`data-chart-route="${route}" data-chart-description="Concept study:`));
  });
  it('retains ordinary new-tab behaviour',()=>{
    const link=document.querySelector<HTMLAnchorElement>('[data-chart-route="finance"]')!;
    const frame=document.querySelector<HTMLIFrameElement>('#chart-showcase-frame')!;
    const old=frame.src;
    link.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0,ctrlKey:true}));
    expect(frame.src).toBe(old);
    expect(link.getAttribute('href')).toBe('./charts/#finance');
  });
});

