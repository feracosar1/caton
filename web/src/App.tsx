import { useState, useEffect } from 'react'
import { createClient } from '@supabase/supabase-js'
import { VeeduriaExpedientes } from './VeeduriaExpedientes.js'

const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL as string
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string

const sb = createClient(SUPABASE_URL, SUPABASE_ANON)

export default function App() {
  const [session, setSession] = useState<{ access_token: string } | null>(null)
  const [email, setEmail]     = useState('')
  const [pass, setPass]       = useState('')
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: { subscription } } = sb.auth.onAuthStateChange((_, s) => setSession(s))
    return () => subscription.unsubscribe()
  }, [])

  async function login(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setError('')
    const { error } = await sb.auth.signInWithPassword({ email, password: pass })
    if (error) setError(error.message)
    setLoading(false)
  }

  if (!session) return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#F5F3EF', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    }}>
      <div style={{ background: '#fff', padding: '2.5rem', borderRadius: 12, width: 360, boxShadow: '0 4px 24px rgba(0,0,0,.08)' }}>
        <div style={{ marginBottom: '2rem', textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#0F3D2E', letterSpacing: -1 }}>CATÓN</div>
          <div style={{ fontSize: 13, color: '#5A6472', marginTop: 4 }}>Veeduría Ciudadana</div>
        </div>
        <form onSubmit={login}>
          <input
            type="email" placeholder="Correo" value={email}
            onChange={e => setEmail(e.target.value)} required
            style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1.5px solid #E0DDD8', marginBottom: 10, fontSize: 14, boxSizing: 'border-box' }}
          />
          <input
            type="password" placeholder="Contraseña" value={pass}
            onChange={e => setPass(e.target.value)} required
            style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1.5px solid #E0DDD8', marginBottom: 10, fontSize: 14, boxSizing: 'border-box' }}
          />
          {error && <div style={{ color: '#b91c1c', fontSize: 13, marginBottom: 8 }}>{error}</div>}
          <button type="submit" disabled={loading} style={{
            width: '100%', padding: '11px', background: '#0F3D2E', color: '#fff',
            border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer',
          }}>
            {loading ? 'Ingresando...' : 'Ingresar'}
          </button>
        </form>
      </div>
    </div>
  )

  return (
    <div style={{ minHeight: '100vh', background: '#F5F3EF' }}>
      <VeeduriaExpedientes
        token={session.access_token}
        sbUrl={SUPABASE_URL}
        sbAnon={SUPABASE_ANON}
      />
    </div>
  )
}
