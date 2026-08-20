import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { api, MergedEvent, Settings, StatusResponse } from './api';

interface Store {
  events: MergedEvent[];
  settings: Settings | null;
  status: StatusResponse | null;
  refreshing: boolean;
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
  const pollRef = useRef<number | null>(null);

  const loadEvents = useCallback(async () => {
    setEvents(await api.events());
  }, []);

  const loadStatus = useCallback(async () => {
    const s = await api.status();
    setStatus(s);
    setRefreshing(s.refreshing);
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await api.refresh();
      await Promise.all([loadEvents(), loadStatus()]);
    } finally {
      setRefreshing(false);
    }
  }, [loadEvents, loadStatus]);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    setSettings(await api.saveSettings(patch));
  }, []);

  const setGroupFlag = useCallback(
    async (group: string, flags: { starred?: boolean; hidden?: boolean }) => {
      setEvents((prev) => prev.map((ev) => (ev.group === group ? { ...ev, ...flags } : ev)));
      await api.setGroupFlag(group, flags);
    },
    []
  );

  /**
   * Merging changes which rows belong together, so the merged view has to come
   * back from the server rather than be patched locally.
   */
  const mergeGroups = useCallback(
    async (groups: string[]) => {
      const { group } = await api.merge(groups);
      await loadEvents();
      return group;
    },
    [loadEvents]
  );

  const unmergeGroup = useCallback(
    async (group: string) => {
      await api.unmerge(group);
      await loadEvents();
    },
    [loadEvents]
  );

  useEffect(() => {
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
  }, [loadEvents, loadStatus]);

  /**
   * While a refresh runs, ask more often.
   *
   * A refresh takes minutes and the progress feed is the only sign of life,
   * so the thirty-second poll above would show it in jumps. This one only
   * exists while something is actually running.
   */
  useEffect(() => {
    if (!refreshing) return;
    const id = window.setInterval(() => {
      loadStatus().catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(id);
  }, [refreshing, loadStatus]);

  return (
    <StoreContext.Provider
      value={{
        events, settings, status, refreshing, loadEvents, loadStatus, refresh,
        updateSettings, setGroupFlag, mergeGroups, unmergeGroup,
      }}
    >
      {children}
    </StoreContext.Provider>
  );
}
