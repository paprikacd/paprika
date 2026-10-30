import { fireEvent, render, screen } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { SavedQueryLibraryProvider } from "./saved-query-context"
import { SelectionEditor } from "./selection-editor"
import type { Widget } from "./schema"

it("adds an explicit current-dashboard field binding without altering the widget's links", () => {
  const widget: Widget = { id: "companies", title: "Companies", type: "plugin", pluginId: "record-treemap", dataKind: "records", providerId: "data", query: "SELECT 1", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 }, drilldowns: [{ id: "detail", title: "Detail", dashboardId: "detail" }] }
  const onChange = vi.fn()
  render(<SavedQueryLibraryProvider queries={[]} variables={[{ name: "company", label: "Company" }]} values={{}}><SelectionEditor widget={widget} onChange={onChange} /></SavedQueryLibraryProvider>)
  fireEvent.click(screen.getByRole("button", { name: "Add selection binding" }))
  expect(onChange).toHaveBeenCalledWith({ ...widget, selectionBindings: [{ variable: "company", source: "label", value: "company" }] })
})

it("offers explicit dashboard variable bindings for a connection map", () => {
  const widget: Widget = { id:"map",title:"Map",type:"plugin",pluginId:"connection-map",dataKind:"records",providerId:"data",query:"SELECT 1",unit:"",layout:{x:0,y:0,w:6,h:4} }
  const onChange=vi.fn()
  render(<SavedQueryLibraryProvider queries={[]} variables={[{name:"location",label:"Location"}]} values={{}}><SelectionEditor widget={widget} onChange={onChange}/></SavedQueryLibraryProvider>)
  fireEvent.click(screen.getByRole("button",{name:"Add selection binding"}))
  expect(onChange).toHaveBeenCalledWith({...widget,selectionBindings:[{variable:"location",source:"label",value:"location"}]})
})

it("suggests loaded record keys when connecting a selection without changing a typed value", () => {
  const widget: Widget = { id: "companies", title: "Companies", type: "plugin", pluginId: "record-treemap", dataKind: "records", providerId: "data", query: "SELECT 1", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 }, selectionBindings: [{ variable: "company", source: "label", value: "ticker" }] }
  const onChange = vi.fn()
  const queryFields = { seriesCount: 0, labels: [], partial: false, recordColumns: [{ name: "ticker", type: "string" }, { name: "sector", type: "string" }] }
  render(<SavedQueryLibraryProvider queries={[]} variables={[{ name: "company" }]} values={{}}><SelectionEditor widget={widget} onChange={onChange} queryFields={queryFields} /></SavedQueryLibraryProvider>)
  const input = screen.getByLabelText("Selection 1 field") as HTMLInputElement
  expect([...input.list!.options].map(option => option.value)).toEqual(["ticker", "sector"])
  expect(screen.getByText(/Available result fields: ticker, sector/)).toBeInTheDocument()
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: "sector" } })
  expect(onChange).toHaveBeenLastCalledWith({ ...widget, selectionBindings: [{ variable: "company", source: "label", value: "sector" }] })
})

it("suggests metric labels and explains when a selected label is absent from some series", () => {
  const widget: Widget = { id: "services", title: "Service shares", type: "plugin", pluginId: "pie", dataKind: "metrics", providerId: "metrics", query: "requests", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 }, selectionBindings: [{ variable: "service", source: "label", value: "service" }] }
  const onChange = vi.fn()
  const queryFields = { seriesCount: 3, labels: [{ name: "service", samples: ["api"], present: 2 }, { name: "region", samples: ["east"], present: 3 }], partial: false }
  render(<SavedQueryLibraryProvider queries={[]} variables={[{ name: "service" }]} values={{}}><SelectionEditor widget={widget} onChange={onChange} queryFields={queryFields} /></SavedQueryLibraryProvider>)
  const input = screen.getByLabelText("Selection 1 field") as HTMLInputElement
  expect([...input.list!.options].map(option => option.value)).toEqual(["service", "region"])
  expect(screen.getByText(/Available result labels: service, region/)).toBeInTheDocument()
  expect(input).toHaveAccessibleDescription(/appears in 2 of 3 loaded series/)
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: "other" } })
  expect(onChange).toHaveBeenLastCalledWith({ ...widget, selectionBindings: [{ variable: "service", source: "label", value: "other" }] })
})

it("warns about missing keys only when the loaded snapshot is complete", () => {
  const widget: Widget = { id: "companies", title: "Companies", type: "plugin", pluginId: "record-treemap", dataKind: "records", providerId: "data", query: "SELECT 1", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 }, selectionBindings: [{ variable: "company", source: "label", value: "ticker" }] }
  const renderEditor = (partial: boolean) => <SavedQueryLibraryProvider queries={[]} variables={[{ name: "company" }]} values={{}}><SelectionEditor widget={widget} onChange={vi.fn()} queryFields={{ seriesCount: 0, labels: [], partial, recordColumns: [{ name: "sector", type: "string" }] }} /></SavedQueryLibraryProvider>
  const view = render(renderEditor(false))
  expect(screen.getByLabelText("Selection 1 field")).toHaveAccessibleDescription(/current result has no “ticker” field/)
  view.rerender(renderEditor(true))
  expect(screen.queryByText(/current result has no/)).toBeNull()
  expect(screen.getByText(/limited result/)).toBeInTheDocument()
})

it("offers explicit dashboard selection bindings for geo heatmap observations", () => {
  const widget: Widget = { id: "geo", title: "Source density", type: "plugin", pluginId: "geo-heatmap", dataKind: "records", providerId: "data", query: "SELECT 1", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 } }
  const onChange = vi.fn()
  render(<SavedQueryLibraryProvider queries={[]} variables={[{ name: "location", label: "Location" }]} values={{}}><SelectionEditor widget={widget} onChange={onChange} /></SavedQueryLibraryProvider>)
  fireEvent.click(screen.getByRole("button", { name: "Add selection binding" }))
  expect(onChange).toHaveBeenCalledWith({ ...widget, selectionBindings: [{ variable: "location", source: "label", value: "location" }] })
})

it.each(["record-treemap", "record-table", "record-list", "record-matrix", "records-line", "records-bar", "pie", "connection-map", "geo-heatmap"])("exposes selection authoring for the %s runtime capability", (pluginId) => {
  const widget: Widget = { id: "candidate", title: "Candidate", type: "plugin", pluginId, dataKind: "records", providerId: "data", query: "SELECT 1", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 } }
  render(<SavedQueryLibraryProvider queries={[]} variables={[{ name: "item", label: "Item" }]} values={{}}><SelectionEditor widget={widget} onChange={vi.fn()} /></SavedQueryLibraryProvider>)
  expect(screen.getByRole("button", { name: "Add selection binding" })).toBeEnabled()
})

it("offers metric-label bindings for a status-history observation", () => {
  const widget: Widget = { id: "states", title: "Node states", type: "plugin", pluginId: "status-history", dataKind: "metrics", providerId: "metrics", query: "node_condition", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 } }
  const onChange = vi.fn()
  render(<SavedQueryLibraryProvider queries={[]} variables={[{ name: "node", label: "Node" }]} values={{}}><SelectionEditor widget={widget} onChange={onChange} /></SavedQueryLibraryProvider>)
  fireEvent.click(screen.getByRole("button", { name: "Add selection binding" }))
  expect(onChange).toHaveBeenCalledWith({ ...widget, selectionBindings: [{ variable: "node", source: "label", value: "node" }] })
})

it("does not expose selection filters for plugins without deliberate activation", () => {
  const widget: Widget = { id: "candidate", title: "Candidate", type: "plugin", pluginId: "distribution-heatmap", dataKind: "metrics", providerId: "data", query: "up", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 } }
  render(<SavedQueryLibraryProvider queries={[]} variables={[{ name: "item" }]} values={{}}><SelectionEditor widget={widget} onChange={vi.fn()} /></SavedQueryLibraryProvider>)
  expect(screen.queryByRole("button", { name: "Add selection binding" })).toBeNull()
})

it("explains and permits removal of inactive bindings without silently discarding them", () => {
  const binding = { variable: "node", source: "label" as const, value: "node" }
  const widget: Widget = { id: "candidate", title: "Candidate", type: "plugin", pluginId: "distribution-heatmap", dataKind: "metrics", providerId: "data", query: "up", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 }, selectionBindings: [binding] }
  const onChange = vi.fn()
  const view = (candidate: Widget) => <SavedQueryLibraryProvider queries={[]} variables={[{ name: "node" }]} values={{}}><SelectionEditor widget={candidate} onChange={onChange} /></SavedQueryLibraryProvider>
  const { rerender } = render(view(widget))
  expect(screen.getByText(/retained but inactive/)).toBeInTheDocument()
  expect(onChange).not.toHaveBeenCalled()
  rerender(view({ ...widget, pluginId: "status-history" }))
  expect(screen.getByLabelText("Selection 1 field")).toHaveValue("node")
  rerender(view(widget))
  fireEvent.click(screen.getByRole("button", { name: "Remove inactive selection bindings" }))
  const expected = { ...widget }
  delete expected.selectionBindings
  expect(onChange).toHaveBeenCalledExactlyOnceWith(expected)
})
