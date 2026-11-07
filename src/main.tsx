import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { TestPrints } from './components/TestPrints'
import './index.css'
import './App.css'

const page = new URLSearchParams(location.search).get('page')

createRoot(document.getElementById('root')!).render(
  <StrictMode>{page === 'tests' ? <TestPrints /> : <App />}</StrictMode>,
)
