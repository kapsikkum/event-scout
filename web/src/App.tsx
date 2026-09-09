import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Home from './pages/Home';
import Events from './pages/Events';
import MapView from './pages/MapView';
import Places from './pages/Places';
import Calendar from './pages/Calendar';
import Settings from './pages/Settings';
import { StoreProvider, useStore } from './store';
import RefreshActivity from './components/RefreshActivity';
import SignIn from './components/SignIn';

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
  const { status, refreshing, refresh, settings, auth, signOut } = useStore();
  const location = useLocation();
  const needsSetup = settings !== null && (settings.lat == null || settings.lng == null);
  const [menuOpen, setMenuOpen] = useState(false);
  const updated = `Updated ${relativeTime(status?.lastRefresh ?? null)}`;

  // The menu is an overlay lying over the page beneath it, so anything that
  // means "I am done with it" has to shut it: following a link, pressing
  // Escape, or tapping the page outside it.
  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <>
      <header className="topbar">
        <button
          className="topbar__burger"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
          aria-controls="topbar-nav"
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? '✕' : '☰'}
        </button>
        <Link to="/" className="logo" title="Home">
          📸 Event<span>Scout</span>
        </Link>
        <nav id="topbar-nav" className={menuOpen ? 'is-open' : ''}>
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
          {/* The bar has no room for the timestamp once it is this narrow, and
              how stale the list is matters as much on a phone as anywhere, so
              it comes along into the menu. Only one of the two is ever shown. */}
          <span className="topbar__nav-meta">{updated}</span>
        </nav>
        <span className="meta">{updated}</span>
        {/* Only worth a place in the bar once a password exists; with none set
            there is nothing to be signed in or out of. */}
        {auth?.required && auth.authed && (
          <button className="topbar__signout" onClick={() => void signOut()} title="Sign out">
            Sign out
          </button>
        )}
        <button className="primary" onClick={() => void refresh()} disabled={refreshing || needsSetup}>
          {refreshing ? <span className="spin">⟳</span> : '⟳'} Refresh
        </button>
      </header>
      {menuOpen && (
        <div className="topbar__scrim" onClick={() => setMenuOpen(false)} aria-hidden="true" />
      )}
      <SignIn />
      <main className="page">
        <RefreshActivity />
        {needsSetup && !location.pathname.startsWith('/settings') && <Navigate to="/settings" replace />}
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/events" element={<Events />} />
          <Route path="/map" element={<MapView />} />
          <Route path="/places" element={<Places />} />
          <Route path="/calendar" element={<Calendar />} />
          {/* Tasks moved into Settings; keep the old address working. */}
          <Route path="/tasks" element={<Navigate to="/settings/tasks" replace />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/settings/:tab" element={<Settings />} />
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
