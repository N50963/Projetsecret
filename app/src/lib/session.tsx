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
  /** Session lue et foyer du compte connecté chargé : les écrans peuvent s'afficher. */
  ready: boolean;
  session: Session | null;
  /** Foyer du compte connecté (null s'il n'en a pas encore). */
  household: Household | null;
  /** Échec du chargement du foyer (réseau…), affiché avec un bouton pour réessayer. */
  householdError: string;
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
  const [sessionRead, setSessionRead] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  // Foyer chargé pour le compte `householdUser`. Il n'est pas effacé à la déconnexion : les écrans encore affichés
  // pendant le retour à la connexion le lisent toujours (useHousehold).
  const [household, setHousehold] = useState<Household | null>(null);
  const [householdUser, setHouseholdUser] = useState<string | null>(null);
  const [householdError, setHouseholdError] = useState("");
  const userId = session?.user.id ?? null;

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session)).finally(() => setSessionRead(true));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => sub.subscription.unsubscribe();
  }, []);

  const refreshHousehold = useCallback(async () => {
    if (!userId) return;
    setHouseholdError("");
    try {
      setHousehold(await loadHousehold(userId));
      setHouseholdUser(userId);
    } catch (e) {
      setHouseholdError(e instanceof Error ? e.message : String(e));
    }
  }, [userId]);

  // Chargé à la connexion seulement (pas au rafraîchissement du jeton, qui garde le même compte).
  useEffect(() => {
    void refreshHousehold();
  }, [refreshHousehold]);

  const ready = sessionRead && (!userId || householdUser === userId);
  const value = useMemo<SessionState>(() => ({
    ready, session, household: userId && householdUser === userId ? household : null, householdError, refreshHousehold,
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
  }), [ready, session, userId, householdUser, household, householdError, refreshHousehold]);

  return (
    <SessionContext.Provider value={value}>
      <LastHouseholdContext.Provider value={household}>{children}</LastHouseholdContext.Provider>
    </SessionContext.Provider>
  );
}

const LastHouseholdContext = createContext<Household | null>(null);

export function useSession(): SessionState {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession hors de SessionProvider");
  return value;
}

/**
 * Foyer courant, pour les écrans réservés aux membres (Stack.Protected dans _layout.tsx). Après une déconnexion, ces
 * écrans peuvent s'afficher une dernière fois : ils reçoivent alors le dernier foyer chargé.
 */
export function useHousehold(): Household {
  const household = useContext(LastHouseholdContext);
  if (!household) throw new Error("Aucun foyer");
  return household;
}
