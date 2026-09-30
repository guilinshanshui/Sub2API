import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { ConfirmProvider, ToastProvider } from './components/ui.js'
import './styles.css'

const root = document.getElementById('root')
if (root === null) throw new Error('Root element was not found')

createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ToastProvider>
  </StrictMode>,
)
