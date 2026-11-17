import { Component, type ReactNode } from 'react';

/** Last-resort isolation for a renderer's preview-only component tree.
 * A failed visualization never takes out the editor, data inspector or Apply controls.
 * Changing the validated renderer/config remounts this boundary via its React key.
 */
export class WidgetPreviewBoundary extends Component<{
  children?: ReactNode;
  onFailure: () => void;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    this.props.onFailure();
  }

  render(): ReactNode {
    if (this.state.failed) {
      return <div className="we-render-error" role="alert" data-widget-preview-error>
        <strong>Preview unavailable for this visualization</strong>
        <p>The configuration was not applied. Undo the change or select a different compatible renderer. Your loaded data and existing panel remain intact.</p>
      </div>;
    }
    return this.props.children;
  }
}

