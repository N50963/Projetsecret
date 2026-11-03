/**
 * Demande de confirmation au style MenuBily (annuler un menu, supprimer une recette) : panneau qui monte du bas de
 * l'écran, comme les rappels, avec la photo du plat, son nom, ce qui va se passer, et deux boutons de l'application.
 * Remplace la fenêtre d'alerte du système (Android) et celle du navigateur (version web).
 *
 * Usage : const [ask, sheet] = useConfirm(); … ask({ title, … , onConfirm }); … {sheet} dans l'écran.
 */

import { Image } from "expo-image";
import { useCallback, useState, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { placeholderOf, sourceOf, type Picture } from "../lib/images";
import { useColors } from "../lib/theme";
import { Icon, type IconName } from "./icons";
import { Button } from "./ui";

export interface ConfirmRequest {
  /** Question (« Annuler ce menu ? »). */
  title: string;
  /** Plat concerné : photo, nom et précision (« Mercredi 4 novembre · Dîner »). */
  picture?: Picture | null;
  name?: string;
  detail?: string;
  /** Ce qui va se passer, en une ou deux phrases. */
  message?: string;
  /** Bouton qui confirme (« Annuler ce menu »), et bouton qui renonce (« Garder ce menu »). */
  confirmLabel: string;
  cancelLabel?: string;
  icon?: IconName;
  onConfirm: () => void;
}

export function ConfirmSheet({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const r = request;
  const confirm = () => {
    if (!r) return;
    onClose();
    r.onConfirm();
  };
  return (
    <Modal visible={Boolean(r)} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={r?.cancelLabel ?? "Fermer"} />
      {r && (
        <View style={[styles.sheet, { backgroundColor: c.background, paddingBottom: 18 + insets.bottom }]}
          accessibilityViewIsModal accessibilityRole="alert">
          <View style={[styles.handle, { backgroundColor: c.border }]} />
          <Text style={[styles.title, { color: c.text }]} accessibilityRole="header">{r.title}</Text>
          {r.name ? (
            <View style={[styles.dish, { backgroundColor: c.card, borderColor: c.cardLine }]}>
              {r.picture
                ? <Image source={sourceOf(r.picture, true)} placeholder={placeholderOf(r.picture, true)} placeholderContentFit="cover"
                  cachePolicy="memory-disk" style={styles.photo} contentFit="cover" transition={0} accessibilityLabel="Photo du plat" />
                : <View style={[styles.photo, styles.noPhoto, { backgroundColor: c.chip }]}><Icon name="image" size={24} color={c.muted} /></View>}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[styles.name, { color: c.text }]} numberOfLines={2}>{r.name}</Text>
                {r.detail ? <Text style={[styles.detail, { color: c.muted }]}>{r.detail}</Text> : null}
              </View>
            </View>
          ) : null}
          {r.message ? <Text style={[styles.message, { color: c.muted }]}>{r.message}</Text> : null}
          <View style={styles.buttons}>
            <Button title={r.confirmLabel} kind="danger" icon={r.icon ?? "cross"} onPress={confirm} />
            <Button title={r.cancelLabel ?? "Garder"} kind="secondary" onPress={onClose} />
          </View>
        </View>
      )}
    </Modal>
  );
}

/** Demande de confirmation d'un écran : `ask(...)` ouvre le panneau ; l'élément rendu se place dans l'écran. */
export function useConfirm(): [(request: ConfirmRequest) => void, ReactNode] {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const ask = useCallback((r: ConfirmRequest) => setRequest(r), []);
  return [ask, <ConfirmSheet key="confirm" request={request} onClose={() => setRequest(null)} />];
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(26,29,25,0.45)" },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 16, paddingTop: 8, gap: 14 },
  handle: { alignSelf: "center", width: 44, height: 5, borderRadius: 3 },
  title: { fontSize: 22, lineHeight: 27, fontWeight: "700", marginTop: 4 },
  dish: { flexDirection: "row", alignItems: "center", gap: 12, borderRadius: 14, borderWidth: 1, padding: 10 },
  photo: { width: 74, height: 58, borderRadius: 10 },
  noPhoto: { alignItems: "center", justifyContent: "center" },
  name: { fontSize: 16.5, lineHeight: 21, fontWeight: "700" },
  detail: { fontSize: 14.2, lineHeight: 18, marginTop: 2 },
  message: { fontSize: 15.5, lineHeight: 21 },
  buttons: { gap: 10, marginTop: 2 },
});
