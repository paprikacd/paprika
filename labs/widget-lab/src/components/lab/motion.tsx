import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type MotionPreference = 'auto' | 'reduced';
type ReplayRegistration = { token: symbol; advance: () => void };

interface LabMotion {
  preference: MotionPreference;
  setPreference: (preference: MotionPreference) => void;
  reduced: boolean;
  hasReplay: boolean;
  replaying: boolean;
  toggleReplay: () => void;
  registerReplay: (advance: () => void) => () => void;
}

const MotionContext = createContext<LabMotion>({
  preference: 'auto', setPreference: () => undefined, reduced: true,
  hasReplay: false, replaying: false, toggleReplay: () => undefined,
  registerReplay: () => () => undefined,
});

export function MotionProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<MotionPreference>('auto');
  const [systemReduced, setSystemReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [registration, setRegistration] = useState<ReplayRegistration | null>(null);
  const [replaying, setReplaying] = useState(false);
  const reduced = preference === 'reduced' || systemReduced;

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setSystemReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const registerReplay = useCallback((advance: () => void) => {
    const token = Symbol('study-replay');
    setRegistration({ token, advance });
    setReplaying(false);
    return () => {
      setRegistration(current => current?.token === token ? null : current);
      setReplaying(false);
    };
  }, []);

  // Replay changes the real fixture snapshot. Reduced motion only changes the
  // presentation, never the observation cadence or the values it produces.
  useEffect(() => {
    if (!replaying || !registration) return;
    if (document.hidden) { setReplaying(false); return; }
    const interval = window.setInterval(registration.advance, 1_800);
    const pauseWhenHidden = () => { if (document.hidden) setReplaying(false); };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', pauseWhenHidden);
    };
  }, [replaying, registration]);

  const toggleReplay = useCallback(() => {
    if (registration) setReplaying(current => !current);
  }, [registration]);

  const value = useMemo(() => ({
    preference, setPreference, reduced,
    hasReplay: registration !== null, replaying, toggleReplay, registerReplay,
  }), [preference, reduced, registration, replaying, toggleReplay, registerReplay]);
  return <MotionContext.Provider value={value}>{children}</MotionContext.Provider>;
}

export const useLabMotion = () => useContext(MotionContext);

/** Register only the mounted study; keep its latest callback without resetting replay on each tick. */
export function useDemoReplay(advance: () => void) {
  const { registerReplay } = useLabMotion();
  const latest = useRef(advance);
  useLayoutEffect(() => { latest.current = advance; }, [advance]);
  useEffect(() => registerReplay(() => latest.current()), [registerReplay]);
}
