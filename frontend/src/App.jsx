import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { ToastProvider } from './components/Toast'
import Dashboard from './pages/Dashboard'
import AdbMaster from './pages/AdbMaster'
import FlowSvn from './pages/FlowSvn'
import GmConsole from './pages/GmConsole'

function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/adb_master/*" element={<AdbMaster />} />
          <Route path="/flow_svn/*" element={<FlowSvn />} />
          <Route path="/gm_console/*" element={<GmConsole />} />
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  )
}

export default App
