import { lazy } from "react"
import { CalendarDays, Globe2, Network } from "lucide-react"
import { getWidgetDefinition, registerWidgetPlugin, type WidgetPlugin } from "../widget-registry"
import { connectionMapConfig, incidentCalendarConfig, pipelineTopologyConfig } from "./operational-records-data"

// The renderers and their stylesheet load when a widget of their type first renders, so the plugin registry stays light.
const loadView = () => import("./operational-records-view")
const ConnectionMap = lazy(() => loadView().then((module) => ({ default: module.ConnectionMap })))
const PipelineTopology = lazy(() => loadView().then((module) => ({ default: module.PipelineTopology })))
const IncidentCalendar = lazy(() => loadView().then((module) => ({ default: module.IncidentCalendar })))


/**
 * The bundled record renderer registrations. Exported so a host can replace one renderer and keep the rest of its
 * configuration (fields, defaults and style controls) identical. Bundled renderers only: persisted configuration maps
 * scalar columns and cannot load code.
 */
export function operationalRecordPluginEntries(): Omit<WidgetPlugin, "dataKind">[] {
  return [
    {id:"connection-map",label:"Connection map",description:"Plot supplied geographic coordinates with exact record inspection",render:ConnectionMap,configSchema: connectionMapConfig,
      sizing:{mode:"fill",minHeight:240},
      icon:Globe2,
      capabilities:{thresholds:true},
      defaultConfig:{latitude:"latitude",longitude:"longitude",label:"label",display:"markers",showLocations:true},
      styleControls:["unit","decimals","legend","tooltips","color"],
      configFields:[{key:"latitude",label:"Latitude field",kind:"text" as const},{key:"longitude",label:"Longitude field",kind:"text" as const},{key:"label",label:"Location label field",kind:"text" as const},{key:"value",label:"Value field",kind:"text" as const,help:"Optional numeric field; marker size represents its absolute value."},{key:"status",label:"Status field",kind:"text" as const},{key:"display",label:"Map display",kind:"select" as const,options:[{value:"markers",label:"Markers"},{value:"density",label:"Compact dots"}],help:"Small dots mark the supplied locations; size follows the absolute value. It does not interpolate between them."},{key:"showGrid",label:"Show coordinate grid",kind:"boolean" as const,defaultFor:config=>config?.display!=="density"},{key:"showCoordinates",label:"Show coordinate labels",kind:"boolean" as const,defaultFor:config=>config?.display!=="density"},{key:"showLocations",label:"Show location list",kind:"boolean" as const,help:"Hide the list to give the map more room. Points still expose exact observations."},{key:"maxPoints",label:"Maximum locations",kind:"number" as const,min:1,max:500}]},
    {id:"pipeline-topology",label:"Pipeline topology",description:"Follow recorded directed connections, including cycles and missing values",render:PipelineTopology,configSchema: pipelineTopologyConfig,
      icon:Network,
      defaultConfig:{source:"source",target:"target"},
      styleControls:["unit","decimals","tooltips"],
      configFields:[{key:"source",label:"Source stage field",kind:"text" as const},{key:"target",label:"Target stage field",kind:"text" as const},{key:"value",label:"Connection value field",kind:"text" as const,help:"Optional numeric field. Duplicate connections sum their values; missing values remain unknown."},{key:"status",label:"Status field",kind:"text" as const},{key:"maxNodes",label:"Maximum stages",kind:"number" as const,min:2,max:64},{key:"maxEdges",label:"Maximum connections",kind:"number" as const,min:1,max:200}]},
    {id:"incident-calendar",label:"Incident calendar",description:"Aggregate recorded events by UTC day without inventing healthy days",render:IncidentCalendar,configSchema: incidentCalendarConfig,
      sizing:{mode:"fill",denseRoom:()=>"calendar",referenceFineRows:config=>config?.months===1?11:undefined},
      icon:CalendarDays,
      capabilities:{thresholds:config=>config?.colorMode==="thresholds"},
      defaultConfig:{date:"date",aggregation:"count",months:3},
      styleControls:["unit","decimals","legend","tooltips"],
      configFields:[{key:"date",label:"Date field",kind:"text" as const},{key:"value",label:"Value field",kind:"text" as const},{key:"label",label:"Event label field",kind:"text" as const},{key:"status",label:"Status field",kind:"text" as const},{key:"aggregation",label:"Daily aggregation",kind:"select" as const,options:[{value:"count",label:"Count records"},{value:"sum",label:"Sum values"},{value:"max",label:"Maximum value"}]},{key:"colorMode",label:"Day colors",kind:"select" as const,options:[{value:"intensity",label:"Value intensity"},{value:"thresholds",label:"Value thresholds"}],help:"Threshold colors apply to the aggregated value; missing observations stay unknown."},{key:"months",label:"Months",kind:"number" as const,min:1,max:6},{key:"endDate",label:"End month date",kind:"text" as const,placeholder:"YYYY-MM-DD",help:"Optional. Otherwise the latest recorded UTC date anchors the displayed months."}]},
  ]
}

/** Bundled renderers only. Persisted configuration maps scalar columns; it cannot load code. */
export function registerOperationalRecordPlugins() {
  for(const entry of operationalRecordPluginEntries()) if(!getWidgetDefinition("plugin",entry.id)) registerWidgetPlugin({...entry,dataKind:"records"})
}
