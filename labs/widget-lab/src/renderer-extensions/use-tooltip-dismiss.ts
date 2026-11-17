import { useTooltipDismiss as useOwnerDismiss } from '@insights/tooltip-dismiss';

/**
 * The hover and focus grace of a lab family, on production's dismiss controller. A pointer that moves from the chart
 * into its portalled inspector stays inside the chart in React's tree, so the chart reports no leave. The inspector's
 * own leave schedules the dismissal, so the owner never needs to report engagement.
 */
export function useTooltipDismiss(options: { onDismiss: () => void; pinned: boolean; revision: unknown; enabled?: boolean }) {
  return useOwnerDismiss({ ...options, engaged: noEngagement });
}

const noEngagement = () => false;
