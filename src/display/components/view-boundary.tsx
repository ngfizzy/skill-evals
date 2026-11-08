import { Component, type ReactNode } from 'react';

export class ViewBoundary extends Component<
  { children: ReactNode; onFailure(error: unknown): void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(error: Error): void {
    this.props.onFailure(error);
  }
  render(): ReactNode {
    return this.state.failed ? (
      <text>Display error; saving results and closing.</text>
    ) : (
      this.props.children
    );
  }
}
