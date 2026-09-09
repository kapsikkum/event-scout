import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { api, AuthStatus, MergedEvent, Settings, StatusResponse, Unauthorized } from './api';

interface Store {
  events: MergedEvent[];
  settings: Settings | null;
  status: StatusResponse | null;
  refreshing: boolean;
  /** Null until the first answer comes back. */
  auth: AuthStatus | null;
  /** Set when something was refused for want of a sign-in; drives the prompt. */
  authPrompt: string | null;
  dismissAuthPrompt: () => void;
  /** Raise the prompt without waiting for something to be refused. */
  requestSignIn: () => void;
  loadAuth: () => Promise<void>;
  signIn: (password: string) => Promise<void>;
  signOut: () => Promise<void>;
  loadEvents: () => Promise<void>;
  loadStatus: () => Promise<void>;
  refresh: () => Promise<void>;
  updateSettings: (s: Partial<Settings>) => Promise<void>;
  setGroupFlag: (group: string, flags: { starred?: boolean; hidden?: boolean }) => Promise<void>;
  mergeGroups: (groups: string[]) => Promise<string>;
  unmergeGroup: (group: string) => Promise<void>;
}

const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore outside provider');
  return store;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [events, setEvents] = useState<MergedEvent[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authPrompt, setAuthPrompt] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const loadAuth = useCallback(async () => {
    setAuth(await api.authStatus());
  }, []);

  /**
   * Everything that changes something goes through here.
   *
   * A refusal for want of a sign-in is not an error to report but a question to
   * ask, and funnelling it through one place is the whole reason `Unauthorized`
   * is its own type: any action anywhere raises the same prompt.
   */
  const guard = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch (err) {
        if (err instanceof Unauthorized) {
          setAuthPrompt(err.message);
          void loadAuth();
        }
        throw err;
      }
    },
    [loadAuth]
  );

  const signIn = useCallback(
    async (password: string) => {
      await api.login(password);
      setAuthPrompt(null);
      await loadAuth();
      // Settings are gated, so they arrive only now.
      await api.settings().then(setSettings).catch(() => undefined);
    },
    [loadAuth]
  );

  const signOut = useCallback(async () => {
    await api.logout();
    setSettings(null);
    await loadAuth();
  }, [loadAuth]);

  const loadEvents = useCallback(async () => {
    setEvents(await api.events());
  }, []);

  /**
   * Ask for the status, unless we are still waiting on the last answer.
   *
   * The server is single-threaded and its database calls are synchronous, so
   * a heavy moment during a refresh stalls every request behind it. Polling
   * on a timer regardless put a queue of identical requests on a server that
   * was already busy, and nginx timed fifty-five of them out in an hour. One
   * in flight at a time is enough to see progress and cannot pile up.
   */
  const statusInFlight = useRef(false);
  const loadStatus = useCallback(async () => {
    if (statusInFlight.current) return;
    statusInFlight.current = true;
    try {
      const s = await api.status();
      setStatus(s);
      setRefreshing(s.refreshing);
    } finally {
      statusInFlight.current = false;
    }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await guard(() => api.refresh());
      await Promise.all([loadEvents(), loadStatus()]);
    } finally {
      setRefreshing(false);
    }
  }, [loadEvents, loadStatus, guard]);

  const updateSettings = useCallback(
    async (patch: Partial<Settings>) => {
      setSettings(await guard(() => api.saveSettings(patch)));
    },
    [guard]
  );

  const setGroupFlag = useCallback(
    async (group: string, flags: { starred?: boolean; hidden?: boolean }) => {
      setEvents((prev) => prev.map((ev) => (ev.group === group ? { ...ev, ...flags } : ev)));
      try {
        await guard(() => api.setGroupFlag(group, flags));
      } catch {
        // The optimistic paint was a guess and the server said no; put it back.
        await loadEvents();
      }
    },
    [guard, loadEvents]
  );

  /**
   * Merging changes which rows belong together, so the merged view has to come
   * back from the server rather than be patched locally.
   */
  const mergeGroups = useCallback(
    async (groups: string[]) => {
      const { group } = await guard(() => api.merge(groups));
      await loadEvents();
      return group;
    },
    [loadEvents, guard]
  );

  const unmergeGroup = useCallback(
    async (group: string) => {
      await guard(() => api.unmerge(group));
      await loadEvents();
    },
    [loadEvents, guard]
  );

  useEffect(() => {
    loadAuth().catch(() => undefined);
    // Settings are one of the two gated reads, so a signed-out visitor simply
    // has none; the pages that need them say so rather than erroring.
    api.settings().then(setSettings).catch(() => setSettings(null));
    loadEvents().catch(() => undefined);
    loadStatus().catch(() => undefined);
    // Light polling so a server-side auto-refresh shows up without a reload.
    pollRef.current = window.setInterval(() => {
      loadStatus().catch(() => undefined);
    }, 30000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [loadEvents, loadStatus, loadAuth]);

  /**
   * While a refresh runs, ask more often.
   *
   * A refresh takes minutes and the progress feed is the only sign of life,
   * so the thirty-second poll above would show it in jumps. Three seconds is
   * frequent enough to read as live without leaning on a server that is busy
   * doing the actual work; loadStatus drops a tick if the last is unanswered.
   */
  useEffect(() => {
    if (!refreshing) return;
    const id = window.setInterval(() => {
      loadStatus().catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(id);
  }, [refreshing, loadStatus]);

  return (
    <StoreContext.Provider
      value={{
        events, settings, status, refreshing, loadEvents, loadStatus, refresh,
        updateSettings, setGroupFlag, mergeGroups, unmergeGroup,
        auth, authPrompt, dismissAuthPrompt: () => setAuthPrompt(null),
        requestSignIn: () => setAuthPrompt('Settings and changes need the password.'),
        loadAuth, signIn, signOut,
      }}
    >
      {children}
    </StoreContext.Provider>
  );
}
