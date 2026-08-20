import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Home from './pages/Home';
import Events from './pages/Events';
import MapView from './pages/MapView';
import Places from './pages/Places';
import Calendar from './pages/Calendar';
import Settings from './pages/Settings';
import { StoreProvider, useStore } from './store';

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function Shell() {
  const { status, refreshing, refresh, settings } = useStore();
  const location = useLocation();
  const needsSetup = settings !== null && (settings.lat == null || settings.lng == null);

  return (
    <>
      <header className="topbar">
        <Link to="/" className="logo" title="Home">
          📸 Event<span>Scout</span>
        </Link>
        <nav>
          <NavLink to="/events" className={({ isActive }) => (isActive ? 'active' : '')}>
            Events
          </NavLink>
          <NavLink to="/map" className={({ isActive }) => (isActive ? 'active' : '')}>
            Map
          </NavLink>
          <NavLink to="/places" className={({ isActive }) => (isActive ? 'active' : '')}>
            Places
          </NavLink>
          <NavLink to="/calendar" className={({ isActive }) => (isActive ? 'active' : '')}>
            Calendar
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>
            Settings
          </NavLink>
        </nav>
        <span className="meta">Updated {relativeTime(status?.lastRefresh ?? null)}</span>
        <button className="primary" onClick={() => void refresh()} disabled={refreshing || needsSetup}>
          {refreshing ? <span className="spin">⟳</span> : '⟳'} Refresh
        </button>
      </header>
      <main className="page">
        {needsSetup && location.pathname !== '/settings' && <Navigate to="/settings" replace />}
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/events" element={<Events />} />
          <Route path="/map" element={<MapView />} />
          <Route path="/places" element={<Places />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
