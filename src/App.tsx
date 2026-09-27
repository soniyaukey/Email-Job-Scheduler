import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react'
import {
  ArrowDownToLine, ArrowUpRight, CalendarClock, Check, ChevronDown, Clock3,
  FileUp, Inbox, LogOut, Mail, Plus, RefreshCw, Send, ShieldCheck, Sparkles, X,
} from 'lucide-react'
import './App.css'

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'
type View = 'scheduled' | 'sent'
type EmailRecord = {
  id: string
  recipient: string
  subject: string
  scheduled_at?: string
  sent_at?: string | null
  status: 'scheduled' | 'sending' | 'sent' | 'failed'
  sender_email: string
  error?: string | null
}
type User = { email: string; name: string; picture: string }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(payload?.error ?? `Request failed (${response.status})`)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

function displayDate(value?: string | null) {
  if (!value) return '—'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(value))
}

function findEmails(text: string) {
  return [...new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [])]
}

function App() {
  const [user, setUser] = useState<User | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [view, setView] = useState<View>('scheduled')
  const [emails, setEmails] = useState<EmailRecord[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [leadFile, setLeadFile] = useState('')
  const [leadName, setLeadName] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [delaySeconds, setDelaySeconds] = useState('2')
  const [hourlyLimit, setHourlyLimit] = useState('200')
  const [maxHourlyLimit, setMaxHourlyLimit] = useState(200)
  const [minimumDelaySeconds, setMinimumDelaySeconds] = useState(2)
  const [refreshKey, setRefreshKey] = useState(0)
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())

  useEffect(() => {
    let active = true
    api<{ user: User }>('/api/auth/me')
      .then(({ user: profile }) => { if (active) setUser(profile) })
      .catch(() => { if (active) setUser(null) })
      .finally(() => { if (active) setAuthLoading(false) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!user) return
    api<{ maxEmailsPerHourPerSender: number; minSendDelayMs: number }>('/api/emails/config')
      .then((settings) => {
        setMaxHourlyLimit(settings.maxEmailsPerHourPerSender)
        setHourlyLimit(String(settings.maxEmailsPerHourPerSender))
        setMinimumDelaySeconds(Math.ceil(settings.minSendDelayMs / 1000))
        setDelaySeconds(String(Math.ceil(settings.minSendDelayMs / 1000)))
      })
      .catch(() => undefined)
  }, [user])

  useEffect(() => {
    if (!user) return
    let active = true
    Promise.resolve().then(() => {
      if (active) {
        setListLoading(true)
        setListError('')
      }
      return api<{ emails: EmailRecord[] }>(`/api/emails?status=${view}`)
    })
      .then(({ emails: rows }) => { if (active) setEmails(rows) })
      .catch((error: unknown) => {
        if (active) setListError(error instanceof Error ? error.message : 'Could not load emails.')
      })
      .finally(() => { if (active) setListLoading(false) })
    return () => { active = false }
  }, [user, view, refreshKey])

  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(''), 4500)
    return () => window.clearTimeout(timeout)
  }, [notice])

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setLeadName(file.name)
    setLeadFile(await file.text())
  }

  const handleSchedule = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const recipients = findEmails(leadFile)
    if (recipients.length === 0) {
      setNotice('No email addresses found. Add a CSV or text file with lead emails.')
      return
    }
    if (!startsAt) {
      setNotice('Choose when this sequence should start.')
      return
    }
    setBusy(true)
    try {
      await api('/api/emails', {
        method: 'POST',
        body: JSON.stringify({
          idempotencyKey, subject, body, recipients,
          startsAt: new Date(startsAt).toISOString(),
          sendDelayMs: Number(delaySeconds) * 1000,
          hourlyLimit: Number(hourlyLimit),
        }),
      })
      setView('scheduled')
      setModalOpen(false)
      setSubject('')
      setBody('')
      setLeadFile('')
      setLeadName('')
      setIdempotencyKey(crypto.randomUUID())
      setNotice(`${recipients.length} ${recipients.length === 1 ? 'email' : 'emails'} added to your schedule.`)
      const { emails: rows } = await api<{ emails: EmailRecord[] }>('/api/emails?status=scheduled')
      setEmails(rows)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Schedule request failed.')
    } finally {
      setBusy(false)
    }
  }

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined)
    setUser(null)
    setEmails([])
  }

  if (authLoading) return <main className="auth-loading"><span className="loader" /><span>Opening your workspace</span></main>

  if (!user) return (
    <main className="login-screen">
      <div className="login-visual" aria-hidden="true">
        <div className="visual-topline"><span className="brand-mark"><Send size={15} /></span> reachinbox <span className="visual-status"><i /> SYSTEM READY</span></div>
        <div className="visual-copy"><div className="eyebrow"><Sparkles size={14} /> OUTREACH, IN MOTION</div><h1>Make every<br />send <em>count.</em></h1><p>Thoughtful timing. Reliable delivery.<br />A calmer way to reach the right people.</p></div>
        <div className="orbit-card orbit-card-one"><span className="orbit-icon"><Check size={16} /></span><div><strong>Sequence queued</strong><small>Delivery is on its way</small></div><span className="orbit-time">NOW</span></div>
        <div className="orbit-card orbit-card-two"><span className="orbit-spark">✳</span><div><strong>2,418</strong><small>messages delivered</small></div><div className="tiny-bars"><i /><i /><i /><i /><i /><i /><i /></div></div>
        <div className="visual-footer"><span>BUILT FOR THE HUMAN SIDE OF GROWTH</span><span>01 — 03</span></div>
      </div>
      <div className="login-panel"><div className="panel-brand"><span className="brand-mark"><Send size={15} /></span> reachinbox</div><div className="login-content"><span className="login-kicker">YOUR OUTREACH WORKSPACE</span><h2>Good work starts<br />with a <span>hello.</span></h2><p>Sign in to manage your email schedules, keep an eye on delivery, and stay close to every conversation.</p><a className="google-button" href={`${apiUrl}/api/auth/google`}><GoogleMark /> Continue with Google <ArrowUpRight size={16} /></a><div className="secure-note"><ShieldCheck size={15} /> Secure sign-in with Google</div></div><div className="login-bottom"><span>© 2026 OUTBOX LABS</span><a href="https://reachinbox.ai" target="_blank" rel="noreferrer">REACHINBOX.AI <ArrowUpRight size={11} /></a></div></div>
    </main>
  )

  const isScheduled = view === 'scheduled'
  const sentCount = emails.filter((email) => email.status === 'sent').length

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#home"><span className="brand-mark"><Send size={15} /></span><span>reachinbox</span></a>
        <div className="workspace-switch"><span className="workspace-avatar">O</span><span className="workspace-meta"><strong>Outbox Labs</strong><small>Workspace</small></span><ChevronDown size={14} /></div>
        <div className="nav-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Email views"><button className={isScheduled ? 'nav-item active' : 'nav-item'} onClick={() => setView('scheduled')}><CalendarClock size={17} /><span>Scheduled</span><span className="nav-count">{isScheduled ? emails.length : '·'}</span></button><button className={!isScheduled ? 'nav-item active' : 'nav-item'} onClick={() => setView('sent')}><Send size={17} /><span>Sent emails</span><span className="nav-count">{!isScheduled ? emails.length : '·'}</span></button></nav>
        <div className="sidebar-bottom"><div className="delivery-card"><span className="delivery-icon"><ShieldCheck size={16} /></span><div><strong>Delivery is protected</strong><small>Queue health is looking good</small></div><i /></div><div className="sidebar-user"><img src={user.picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name)}&background=193d34&color=fff`} alt="" /><span><strong>{user.name}</strong><small>{user.email}</small></span><button onClick={logout} className="icon-button" aria-label="Log out" title="Log out"><LogOut size={16} /></button></div></div>
      </aside>
      <section className="main-area">
        <header className="topbar"><div className="breadcrumb"><span>Workspace</span><span className="crumb-divider">/</span><strong>{isScheduled ? 'Scheduled emails' : 'Sent emails'}</strong></div><div className="topbar-right"><span className="live-indicator"><i /> ALL SYSTEMS NORMAL</span><button className="top-user" onClick={logout} title="Log out"><img src={user.picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name)}&background=193d34&color=fff`} alt="" /><span>{user.name}</span><ChevronDown size={13} /></button></div></header>
        <div className="content-wrap">
          <div className="page-intro"><div><div className="page-eyebrow">YOUR PIPELINE <span>•</span> {new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()).toUpperCase()}</div><h1>{isScheduled ? 'Scheduled emails' : 'Sent emails'}<span className="heading-period">.</span></h1><p>{isScheduled ? 'A clear view of what’s going out and when.' : 'Every message, accounted for.'}</p></div><button className="primary-button" onClick={() => setModalOpen(true)}><Plus size={16} /> Compose new email</button></div>
          <section className="summary-strip" aria-label="Email summary"><div className="summary-item"><span className="summary-icon mint"><CalendarClock size={17} /></span><div><small>IN THE QUEUE</small><strong>{isScheduled ? emails.length.toLocaleString() : '—'}</strong></div></div><span className="summary-rule" /><div className="summary-item"><span className="summary-icon peach"><Send size={16} /></span><div><small>DELIVERED</small><strong>{!isScheduled ? sentCount.toLocaleString() : '—'}</strong></div></div><span className="summary-rule" /><div className="summary-item"><span className="summary-icon yellow"><Clock3 size={17} /></span><div><small>PACE</small><strong>Steady <span className="pace-arrow">↗</span></strong></div></div><div className="summary-caption"><span className="caption-dot" /> Updated just now</div></section>
          <section className="list-section"><div className="list-heading"><div><h2>{isScheduled ? 'Upcoming sends' : 'Delivery history'}</h2><p>{isScheduled ? 'Your next messages, in order.' : 'Recently sent and completed messages.'}</p></div><button className="filter-button" onClick={() => setRefreshKey((key) => key + 1)} title="Refresh email list"><RefreshCw size={13} /> Refresh</button></div>
            <div className="table-wrap"><table><thead><tr><th>RECIPIENT</th><th>SUBJECT</th><th>{isScheduled ? 'SCHEDULED FOR' : 'SENT AT'}</th><th>STATUS</th></tr></thead><tbody>
              {listLoading && <tr><td colSpan={4}><div className="table-message"><span className="loader" /> Loading your emails…</div></td></tr>}
              {!listLoading && listError && <tr><td colSpan={4}><div className="table-message error-message">{listError}</div></td></tr>}
              {!listLoading && !listError && emails.length === 0 && <tr><td colSpan={4}><div className="empty-state"><span className="empty-icon"><Inbox size={21} /></span><strong>{isScheduled ? 'Nothing in the queue yet' : 'No sent emails yet'}</strong><span>{isScheduled ? 'When you schedule a sequence, it will show up here.' : 'Messages will appear here after they’ve been sent.'}</span>{isScheduled && <button className="text-button" onClick={() => setModalOpen(true)}><Plus size={14} /> Schedule your first email</button>}</div></td></tr>}
              {!listLoading && !listError && emails.map((email) => <tr key={email.id}><td><div className="recipient-cell"><span className="recipient-avatar">{email.recipient.slice(0, 1).toUpperCase()}</span><span>{email.recipient}</span></div></td><td className="subject-cell">{email.subject}</td><td className="date-cell">{displayDate(isScheduled ? email.scheduled_at : email.sent_at)}</td><td><span className={`status-pill status-${email.status}`}><i />{email.status}</span>{email.error && <span className="error-hint" title={email.error}>i</span>}</td></tr>)}
            </tbody></table></div><div className="table-foot"><span>Showing <strong>{emails.length}</strong> {emails.length === 1 ? 'email' : 'emails'}</span><span>Time shown in your local timezone</span></div></section>
          <footer className="page-foot"><span><span className="footer-mark">R</span> ReachInbox Scheduler</span><span>Small steps, better conversations.</span></footer>
        </div>
      </section>
      {modalOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModalOpen(false) }}><section className="compose-modal" role="dialog" aria-modal="true" aria-labelledby="compose-title"><header className="modal-header"><div><span className="modal-kicker">NEW SEQUENCE</span><h2 id="compose-title">Compose an email</h2></div><button className="icon-button close-button" onClick={() => setModalOpen(false)} aria-label="Close compose dialog"><X size={19} /></button></header><form onSubmit={handleSchedule}>
        <label className="field-label" htmlFor="subject">Subject line</label><input id="subject" className="form-control" value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="A good reason to connect" required maxLength={500} />
        <label className="field-label" htmlFor="body">Email body</label><textarea id="body" className="form-control body-control" value={body} onChange={(event) => setBody(event.target.value)} placeholder={'Hi there,\n\nI thought this might be relevant to your team…'} required maxLength={50000} />
        <div className="field-label upload-label">Lead list <span>CSV or text file</span></div><label className="upload-zone" htmlFor="lead-file"><span className="upload-icon"><FileUp size={18} /></span><span className="upload-copy"><strong>{leadName || 'Choose a lead file'}</strong><small>{leadFile ? `${findEmails(leadFile).length} unique email addresses detected` : 'Emails are extracted automatically from your file'}</small></span><span className="browse-link">Browse <ArrowDownToLine size={13} /></span><input id="lead-file" type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(event) => void handleFile(event)} /></label>
        <div className="field-label timing-label">Timing &amp; delivery</div><div className="settings-grid"><label className="setting-field"><span>Start sending</span><input className="form-control" type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} required /></label><label className="setting-field"><span>Delay between emails</span><div className="input-suffix"><input className="form-control" type="number" min={minimumDelaySeconds} max="86400" value={delaySeconds} onChange={(event) => setDelaySeconds(event.target.value)} required /><small>seconds</small></div></label><label className="setting-field"><span>Hourly limit</span><div className="input-suffix"><input className="form-control" type="number" min="1" max={maxHourlyLimit} value={hourlyLimit} onChange={(event) => setHourlyLimit(event.target.value)} required /><small>per sender</small></div></label></div>
        <div className="modal-note"><ShieldCheck size={15} /><span>Messages are queued safely and paced to respect sender limits.</span></div><footer className="modal-actions"><button type="button" className="cancel-button" onClick={() => setModalOpen(false)}>Cancel</button><button type="submit" className="primary-button" disabled={busy}>{busy ? <><span className="button-spinner" /> Scheduling…</> : <><CalendarClock size={16} /> Schedule emails</>}</button></footer>
      </form></section></div>}
      {notice && <div className="toast" role="status"><Mail size={16} /><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss message"><X size={15} /></button></div>}
    </main>
  )
}

function GoogleMark() {
  return <svg className="google-mark" viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11c-.5 2.5-1.9 4.6-4.1 6v5.1h6.6c3.9-3.6 6.1-8.8 6.1-14.8Z" /><path fill="#34A853" d="M24 44c5.5 0 10.1-1.8 13.5-4.8l-6.6-5.1c-1.8 1.2-4.1 1.9-6.9 1.9-5.3 0-9.9-3.6-11.5-8.5H5.7v5.3C9.1 39.4 16 44 24 44Z" /><path fill="#FBBC05" d="M12.5 27.5a12 12 0 0 1 0-7v-5.3H5.7a20 20 0 0 0 0 17.6l6.8-5.3Z" /><path fill="#EA4335" d="M24 12c3 0 5.7 1 7.8 3.1l5.8-5.8C34.1 6 29.5 4 24 4 16 4 9.1 8.6 5.7 15.2l6.8 5.3C14.1 15.6 18.7 12 24 12Z" /></svg>
}

export default App
