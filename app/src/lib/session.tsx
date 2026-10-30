/** Session de l'application (compte partagé du foyer) et foyer courant. */

import type { Session } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { supabase } from "./supabase";

export interface Household {
  id: string;
  name: string;
  defaultServings: number;
}

interface SessionState {
  ready: boolean;
  session: Session | null;
  household: Household | null;
  signIn(email: string, password: string): Promise<void>;
  changePassword(password: string): Promise<void>;
  signOut(): Promise<void>;
  joinHousehold(code: string): Promise<void>;
  refreshHousehold(): Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

async function loadHousehold(userId: string): Promise<Household | null> {
  const { data, error } = await supabase.from("household_members").select("household_id, households(id, name, default_servings)")
    .eq("user_id", userId).order("created_at").limit(1).maybeSingle();
  if (error) throw new Error(`Foyer illisible : ${error.message}`);
  const h = (data as any)?.households;
  return h ? { id: h.id, name: h.name, defaultServings: h.default_servings ?? 4 } : null;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [household, setHousehold] = useState<Household | null>(null);

  const refreshHousehold = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    setHousehold(data.session ? await loadHousehold(data.session.user.id) : null);
  }, []);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      try {
        setHousehold(data.session ? await loadHousehold(data.session.user.id) : null);
      } finally {
        if (active) setReady(true);
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) setHousehold(null);
      else setTimeout(() => loadHousehold(next.user.id).then(setHousehold).catch(() => setHousehold(null)), 0);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<SessionState>(() => ({
    ready, session, household, refreshHousehold,
    async signIn(email, password) {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw new Error(error.message === "Invalid login credentials" ? "E-mail ou mot de passe incorrect." : error.message);
    },
    async changePassword(password) {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw new Error(error.message);
    },
    async signOut() {
      await supabase.auth.signOut();
    },
    async joinHousehold(code) {
      const { error } = await supabase.rpc("join_household", { p_code: code.trim() });
      if (error) throw new Error(error.message.includes("invalide") ? "Code de foyer invalide." : error.message);
      await refreshHousehold();
    },
  }), [ready, session, household, refreshHousehold]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession hors de SessionProvider");
  return value;
}

/** Foyer courant (les écrans qui l'utilisent ne sont accessibles qu'une fois le foyer rejoint). */
export function useHousehold(): Household {
  const { household } = useSession();
  if (!household) throw new Error("Aucun foyer");
  return household;
}
