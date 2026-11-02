import { useEffect, useState } from 'react';
import type { WidgetRendererProps } from '@insights/widget-registry';

/** Linked pass/time is dashboard scope. Local inspection owns tooltip visibility. */
export function usePassSelection(props: WidgetRendererProps, configured?: string, configuredTimestamp?: number) {
  const [state, setState] = useState(() => ({ result: props.result, request: configured, timeRequest: configuredTimestamp, selected: configured ?? '', timestamp: configuredTimestamp }));
  const currentData = state.result === props.result;
  const selected = currentData && state.request === configured ? state.selected : configured ?? '';
  const timestamp = currentData && state.request === configured && state.timeRequest === configuredTimestamp ? state.timestamp : configuredTimestamp;
  useEffect(() => {
    if (!currentData || state.request !== configured || state.timeRequest !== configuredTimestamp) {
      setState({ result: props.result, request: configured, timeRequest: configuredTimestamp, selected, timestamp });
    }
  }, [props.result, configured, configuredTimestamp, currentData, state.request, state.timeRequest, selected, timestamp]);
  const choose = (id: string, time?: number) => {
    setState({ result: props.result, request: configured, timeRequest: configuredTimestamp, selected: id, timestamp: time });
    props.onContextChange?.({ series: id, labels: { passId: id, timestamp: time === undefined ? '' : String(time) } });
  };
  return { selected, timestamp, choose, currentData };
}
