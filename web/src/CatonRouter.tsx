/**
 * CatonRouter.tsx
 *
 * Router raíz de CATÓN (standalone).
 * Montado en <BrowserRouter> desde caton-main.tsx.
 *
 * Rutas:
 *   /        → CatonLandingPage  (pública, marketing)
 *   /app/*   → CatonApp          (autenticada, dashboard)
 */
import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { CatonLandingPage } from './CatonLandingPage.js'

const CatonApp = lazy(() =>
  import('./CatonApp.js').then(m => ({ default: m.CatonApp }))
)

function Spinner() {
  return (
    <div style={{
      height: '100dvh', background: '#F5F3EF',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <Loader2 size={28} color="#0F3D2E" className="animate-spin" />
    </div>
  )
}

export function CatonRouter() {
  return (
    <Routes>
      {/* Landing pública */}
      <Route path="/" element={<CatonLandingPage />} />

      {/* App autenticada — todo bajo /app/* */}
      <Route
        path="/app/*"
        element={
          <Suspense fallback={<Spinner />}>
            <CatonApp />
          </Suspense>
        }
      />
    </Routes>
  )
}
