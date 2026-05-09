import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Component } from 'react'
import { ToastProvider } from './components/Toast'
import Dashboard from './pages/Dashboard'
import AdbMaster from './pages/AdbMaster'
import FlowSvn from './pages/FlowSvn'
import GmConsole from './pages/GmConsole'
import IosMaster from './pages/IosMaster'

class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null, errorInfo: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error('[ErrorBoundary] React 渲染崩溃:', error, errorInfo)
    this.setState({ errorInfo })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 32, fontFamily: 'monospace', color: '#c0392b', background: '#fef9e7', minHeight: '100vh' }}>
          <h2 style={{ fontSize: 18, marginBottom: 12 }}>React 渲染崩溃</h2>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: '#fff', padding: 12, borderRadius: 6, border: '1px solid #e74c3c' }}>
            {this.state.error?.toString()}
          </pre>
          {this.state.errorInfo && (
            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12 }}>组件调用栈</summary>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, marginTop: 8 }}>
                {this.state.errorInfo.componentStack}
              </pre>
            </details>
          )}
          <button onClick={() => window.location.reload()} style={{ marginTop: 16, padding: '6px 16px', borderRadius: 4, border: '1px solid #e74c3c', background: '#fff', cursor: 'pointer' }}>
            刷新页面
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/adb_master/*" element={<AdbMaster />} />
            <Route path="/flow_svn/*" element={<FlowSvn />} />
            <Route path="/gm_console/*" element={<GmConsole />} />
            <Route path="/ios_master/*" element={<IosMaster />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </ErrorBoundary>
  )
}

export default App
