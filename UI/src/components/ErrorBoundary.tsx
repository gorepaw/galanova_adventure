import React from 'react'

// Catches render-time exceptions in a subtree so one broken panel shows a
// fallback instead of unmounting the whole app (blank screen). Reset it by
// giving it a `key` that changes when you navigate away (e.g. the active tab).
interface ErrorBoundaryProps {
  label?: string;
  children?: React.ReactNode;
}
interface ErrorBoundaryState {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Panel render error:', error, info?.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="panel-error">
          <div className="panel-error-title">{this.props.label || 'This panel'} hit an error.</div>
          <div className="panel-error-msg">{String(this.state.error?.message || this.state.error)}</div>
          <div className="panel-error-hint">Switch tabs and back, or check the console for details.</div>
        </div>
      )
    }
    return this.props.children
  }
}
