import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import { AppProvider } from './state'
import { PrintProvider } from './print/PrintProvider'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <AppProvider>
        <PrintProvider>
          <App />
        </PrintProvider>
      </AppProvider>
    </HashRouter>
  </StrictMode>,
)
