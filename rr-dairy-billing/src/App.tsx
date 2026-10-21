import { Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { IS_DEMO } from './lib/demo'
import { resetDemo } from './db/localSetup'
import { useApp, type Permission } from './state'
import { exportBackup } from './db'
import { downloadFile } from './lib/csv'
import { isDesktop, onBackupRequest, onNavigate, saveBackup, showWindow, toggleFullscreen } from './lib/tauri'
import { initialsOf } from './components/ui'
import { SyncBadge } from './components/SyncBadge'
import { SafetyBanner } from './components/SafetyBanner'
import { startBackupScheduler } from './lib/backup'
import { startHealthReporting } from './lib/health'
import {
  BillingIcon, BillsIcon, CustomersIcon, DashboardIcon, ExpensesIcon, InventoryIcon,
  BoxesIcon, CalendarIcon, CoinsIcon, FileTextIcon, LabelsIcon, Lock, Menu, MoreIcon, PercentIcon, Power, PurchasesIcon, ReceiveIcon,
  ReportsIcon, RotateIcon, SettingsIcon, StockIcon, SupplierIcon,
} from './components/icons'
import Login from './pages/Login'
import Setup from './pages/Setup'
const Dashboard = lazy(() => import('./pages/Dashboard'))
const POS = lazy(() => import('./pages/POS'))
const Bills = lazy(() => import('./pages/Bills'))
const Inventory = lazy(() => import('./pages/Inventory'))
const Stock = lazy(() => import('./pages/Stock'))
const Purchases = lazy(() => import('./pages/Purchases'))
const Labels = lazy(() => import('./pages/Labels'))
const Customers = lazy(() => import('./pages/Customers'))
const Expenses = lazy(() => import('./pages/Expenses'))
const Reports = lazy(() => import('./pages/Reports'))
const Settings = lazy(() => import('./pages/Settings'))
const Collection = lazy(() => import('./pages/Collection'))
const Farmers = lazy(() => import('./pages/Farmers'))
const PaymentRegister = lazy(() => import('./pages/PaymentRegister'))
const RateChart = lazy(() => import('./pages/RateChart'))
const Production = lazy(() => import('./pages/Production'))
const Lots = lazy(() => import('./pages/Lots'))
const Delivery = lazy(() => import('./pages/Delivery'))
const DairyReports = lazy(() => import('./pages/DairyReports'))

interface NavDef { to: string; label: string; short?: string; icon: ReactNode; perm: Permission; hint?: string }

const NAV: Array<{ group: string; items: NavDef[] }> = [
  {
    group: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: <DashboardIcon />, perm: 'reports', hint: 'F9' },
    ],
  },
  {
    group: 'Dairy operations',
    items: [
      { to: '/collection', label: 'Milk Collection', short: 'Milk', icon: <ReceiveIcon />, perm: 'collection' },
      { to: '/farmers', label: 'Farmers', icon: <SupplierIcon />, perm: 'collection' },
      { to: '/payments', label: 'Payments', icon: <CoinsIcon />, perm: 'settlement' },
      { to: '/rates', label: 'Rate Chart', short: 'Rates', icon: <PercentIcon />, perm: 'quality' },
      { to: '/production', label: 'Production', icon: <BoxesIcon />, perm: 'production' },
      { to: '/lots', label: 'Lots & Expiry', short: 'Lots', icon: <CalendarIcon />, perm: 'stock' },
      { to: '/delivery', label: 'Delivery', icon: <RotateIcon />, perm: 'delivery' },
    ],
  },
  {
    group: 'Sales',
    items: [
      { to: '/pos', label: 'Billing (POS)', short: 'Billing', icon: <BillingIcon />, perm: 'pos', hint: 'F1' },
      { to: '/bills', label: 'Bills & Returns', short: 'Bills', icon: <BillsIcon />, perm: 'pos' },
      { to: '/customers', label: 'Customers', icon: <CustomersIcon />, perm: 'customers' },
    ],
  },
  {
    group: 'Stock',
    items: [
      { to: '/inventory', label: 'Products', icon: <InventoryIcon />, perm: 'inventory' },
      { to: '/stock', label: 'Stock Control', short: 'Stock', icon: <StockIcon />, perm: 'stock' },
      { to: '/purchases', label: 'Purchases', icon: <PurchasesIcon />, perm: 'purchases' },
      { to: '/labels', label: 'Barcode Labels', short: 'Labels', icon: <LabelsIcon />, perm: 'inventory' },
    ],
  },
  {
    group: 'Money',
    items: [
      { to: '/expenses', label: 'Expenses', icon: <ExpensesIcon />, perm: 'expenses' },
      { to: '/reports', label: 'Sales Reports', short: 'Sales', icon: <ReportsIcon />, perm: 'reports' },
      { to: '/dairy-reports', label: 'Dairy Reports', short: 'Dairy', icon: <FileTextIcon />, perm: 'reports' },
    ],
  },
]

/** Bottom nav can only hold a handful of destinations — the ones a counter person reaches for most. */
const BOTTOM_NAV_ORDER = ['/', '/pos', '/collection', '/bills', '/inventory']

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const { can } = useApp()
  return (
    <>
      {NAV.map((group) => {
        const items = group.items.filter((i) => can(i.perm))
        if (!items.length) return null
        return (
          <div key={group.group}>
            <div className="nav-group">{group.group}</div>
            {items.map((i) => (
              <NavLink key={i.to} to={i.to} end={i.to === '/'} onClick={onNavigate} title={i.label}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                <span className="ico">{i.icon}</span>
                <span>{i.label}</span>
                {i.hint && <span className="kbd-hint">{i.hint}</span>}
              </NavLink>
            ))}
          </div>
        )
      })}
    </>
  )
}

function SidebarFoot({ onNavigate }: { onNavigate?: () => void }) {
  const { user, logout, can } = useApp()
  if (!user) return null
  return (
    <div className="sidebar-foot">
      <div className="row between" style={{ padding: '2px 10px 8px' }}>
        <span className="tiny" style={{ color: '#6f7b98' }}>Data</span>
        <SyncBadge compact />
      </div>
      {can('settings') && (
        <NavLink to="/settings" onClick={onNavigate} title="Settings" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="ico"><SettingsIcon /></span><span>Settings</span>
        </NavLink>
      )}
      <div className="user-chip">
        <div className="avatar">{initialsOf(user.name)}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: '#fff', fontSize: 12.5, fontWeight: 600 }}>{user.name}</div>
          <div style={{ fontSize: 11, color: '#6f7b98', textTransform: 'capitalize' }}>{user.role}</div>
        </div>
        <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto', color: '#98a1b8' }} onClick={logout} title="Lock the counter"><Power size={15} /></button>
      </div>
    </div>
  )
}

/**
 * Desktop navigation: a dark left sidebar with the shop's name, every section grouped under a heading, and the
 * sync / settings / user controls at the foot. Below ~1180px it narrows to an icon rail; phones use the app bar,
 * bottom nav and drawer instead.
 */
function Sidebar() {
  const { settings, user } = useApp()
  if (!user) return null
  return (
    <aside className="sidebar no-print" aria-label="Main navigation">
      <div className="sb-brand">
        <div className="brand-mark">RD</div>
        <div className="sb-brand-text">
          <div className="sb-name" title={settings?.name}>{settings?.name ?? 'RR Dairy'}</div>
          <div className="sb-sub">Dairy management</div>
        </div>
      </div>
      <nav className="sb-scroll"><NavList /></nav>
      <SidebarFoot />
    </aside>
  )
}

/** Slim bar above every desktop page: where you are, today's date and which collection shift is running. */
function AppHeader() {
  const { user } = useApp()
  const location = useLocation()
  if (!user) return null
  const here = (to: string) => (to === '/' ? location.pathname === '/' : location.pathname.startsWith(to))
  const group = NAV.find((g) => g.items.some((i) => here(i.to)))
  const item = group?.items.find((i) => here(i.to))
  const title = location.pathname === '/settings' ? 'Settings' : item?.label ?? 'RR Dairy'
  const now = new Date()
  const morning = now.getHours() < 14
  return (
    <header className="gh no-print">
      <div className="gh-crumb">
        {group && <><span className="gh-group">{group.group}</span><span className="gh-sep">/</span></>}
        <b>{title}</b>
      </div>
      <div className="grow" />
      <span className="gh-chip">{now.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span>
      <span className="gh-chip gh-shift"><i className="dot" />{morning ? 'Morning shift' : 'Evening shift'}</span>
      {IS_DEMO ? (
        <button className="gh-chip" style={{ cursor: 'pointer' }} title="Reset the demo to its original sample data"
          onClick={() => { if (window.confirm('Reset the demo to its original sample data?')) void resetDemo() }}>Demo data · Reset</button>
      ) : <SyncBadge compact />}
    </header>
  )
}

/** Full-menu slide-out drawer for phones — everything the desktop rail has, reached via the top bar. */
function Drawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { settings } = useApp()
  return (
    <>
      <div className={`drawer-backdrop no-print ${open ? 'show' : ''}`} onClick={onClose} />
      <aside className={`drawer no-print ${open ? 'open' : ''}`}>
        <div className="brand">
          <div className="brand-mark">RD</div>
          <div>
            <div className="brand-name">{settings?.name ?? 'RR Dairy'}</div>
            <div className="brand-sub">Dairy management</div>
          </div>
        </div>
        <div className="drawer-scroll">
          <NavList onNavigate={onClose} />
        </div>
        <SidebarFoot onNavigate={onClose} />
      </aside>
    </>
  )
}

/** Android-style top app bar for phones: menu button, current section, and a lock action. */
function TopAppBar({ title, onMenu }: { title: string; onMenu: () => void }) {
  const { logout } = useApp()
  return (
    <header className="appbar no-print">
      <button className="appbar-btn" onClick={onMenu} aria-label="Open menu"><Menu size={21} /></button>
      <span className="appbar-title">{title}</span>
      <button className="appbar-btn" onClick={logout} aria-label="Lock the counter"><Power size={19} /></button>
    </header>
  )
}

/** Android-style bottom navigation: the 4 destinations staff reach for most, plus a Menu tab for the rest. */
function BottomNav({ onMore }: { onMore: () => void }) {
  const { can } = useApp()
  const location = useLocation()
  const allItems = NAV.flatMap((g) => g.items)
  const items = BOTTOM_NAV_ORDER
    .map((to) => allItems.find((i) => i.to === to))
    .filter((i): i is NavDef => !!i && can(i.perm))
    .slice(0, 4)

  return (
    <nav className="bottom-nav no-print">
      {items.map((i) => {
        const active = i.to === '/' ? location.pathname === '/' : location.pathname.startsWith(i.to)
        return (
          <NavLink key={i.to} to={i.to} end={i.to === '/'} className={`bottom-nav-item ${active ? 'active' : ''}`}>
            <span className="bottom-nav-ico">{i.icon}</span>
            <span>{i.short ?? i.label}</span>
          </NavLink>
        )
      })}
      <button className="bottom-nav-item" onClick={onMore}>
        <span className="bottom-nav-ico"><MoreIcon /></span>
        <span>Menu</span>
      </button>
    </nav>
  )
}

function Guard({ perm, children }: { perm: Permission; children: JSX.Element }) {
  const { can } = useApp()
  if (!can(perm)) {
    return (
      <div className="page">
        <div className="card"><div className="empty">
          <div className="big"><Lock size={24} /></div>
          <div className="bold">You don't have access to this section</div>
          <div className="small">Ask the owner to log in for this.</div>
        </div></div>
      </div>
    )
  }
  return children
}

export default function App() {
  const { ready, needsSetup, user, can, toast } = useApp()
  const navigate = useNavigate()
  const location = useLocation()
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => { setDrawerOpen(false) }, [location.pathname])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F1') { e.preventDefault(); navigate('/pos') }
      if (e.key === 'F9') { e.preventDefault(); navigate('/') }
      if (e.key === 'F11' && isDesktop()) { e.preventDefault(); void toggleFullscreen() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  // Running inside the desktop shell: File → New Bill / Dashboard route
  // through the same navigate() the F1/F9 shortcuts use.
  useEffect(() => onNavigate((path) => navigate(path)), [navigate])

  // File → Backup Data… works from any page, not just Settings, so it's
  // handled once here rather than only while the Settings screen is mounted.
  useEffect(() => onBackupRequest(async () => {
    const dump = await exportBackup()
    const json = JSON.stringify(dump, null, 2)
    if (isDesktop()) {
      const res = await saveBackup(json, `rr-dairy-backup-${new Date().toISOString().slice(0, 10)}.json`)
      if (res.ok) toast('Backup saved', 'ok')
    } else {
      downloadFile(`rr-dairy-backup-${new Date().toISOString().slice(0, 10)}.json`, json, 'application/json')
      toast('Backup downloaded', 'ok')
    }
  }), [toast])

  // The window is created hidden so there's no flash of an unstyled frame
  // before the store data has loaded — reveal it the moment the app is
  // actually ready to show something.
  useEffect(() => { if (ready) showWindow() }, [ready])

  // Once someone is signed in, back up on the chosen schedule for as long as the app stays open.
  useEffect(() => { if (ready && user) { startBackupScheduler(); startHealthReporting() } }, [ready, user])

  const pageTitle = useMemo(() => {
    if (location.pathname === '/settings') return 'Settings'
    const found = NAV.flatMap((g) => g.items).find((i) =>
      i.to === '/' ? location.pathname === '/' : location.pathname.startsWith(i.to))
    return found?.label ?? 'RR Dairy'
  }, [location.pathname])

  if (!ready) {
    return <div className="login-wrap"><div style={{ color: '#fff', fontWeight: 600 }}>Loading store data…</div></div>
  }
  if (needsSetup) return <Setup />
  if (!user) return <Login />

  return (
    <div className="app">
      <Sidebar />
      <TopAppBar title={pageTitle} onMenu={() => setDrawerOpen(true)} />
      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <div className="shell">
      <AppHeader />
      <div className="main">
        <SafetyBanner />
        <Suspense fallback={<div className="page"><div className="skeleton" style={{ height: 120 }} /></div>}>
        <Routes>
          <Route path="/" element={can('reports') ? <Dashboard /> : <Navigate to="/pos" replace />} />
          <Route path="/pos" element={<Guard perm="pos"><POS /></Guard>} />
          <Route path="/bills" element={<Guard perm="pos"><Bills /></Guard>} />
          <Route path="/inventory" element={<Guard perm="inventory"><Inventory /></Guard>} />
          <Route path="/stock" element={<Guard perm="stock"><Stock /></Guard>} />
          <Route path="/purchases" element={<Guard perm="purchases"><Purchases /></Guard>} />
          <Route path="/labels" element={<Guard perm="inventory"><Labels /></Guard>} />
          <Route path="/customers" element={<Guard perm="customers"><Customers /></Guard>} />
          <Route path="/expenses" element={<Guard perm="expenses"><Expenses /></Guard>} />
          <Route path="/reports" element={<Guard perm="reports"><Reports /></Guard>} />
          <Route path="/collection" element={<Guard perm="collection"><Collection /></Guard>} />
          <Route path="/farmers" element={<Guard perm="collection"><Farmers /></Guard>} />
          <Route path="/payments" element={<Guard perm="settlement"><PaymentRegister /></Guard>} />
          <Route path="/rates" element={<Guard perm="quality"><RateChart /></Guard>} />
          <Route path="/production" element={<Guard perm="production"><Production /></Guard>} />
          <Route path="/lots" element={<Guard perm="stock"><Lots /></Guard>} />
          <Route path="/delivery" element={<Guard perm="delivery"><Delivery /></Guard>} />
          <Route path="/dairy-reports" element={<Guard perm="reports"><DairyReports /></Guard>} />
          <Route path="/settings" element={<Guard perm="settings"><Settings /></Guard>} />
          <Route path="*" element={<Navigate to="/pos" replace />} />
        </Routes>
        </Suspense>
      </div>
      </div>
      <BottomNav onMore={() => setDrawerOpen(true)} />
    </div>
  )
}
