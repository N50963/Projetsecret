/**
 * Repas à prévoir en « ruban de la semaine » (maquette Claude Design « Piste A · Ruban de la semaine ») : les 7 jours en
 * pastilles (jour abrégé, numéro, deux barrettes pour le déjeuner et le dîner), puis la carte du jour choisi avec ses deux
 * repas. Un menu déjà choisi s'y affiche avec sa photo (toucher pour la fiche, croix pour l'annuler) ; un repas encore
 * libre se coche (« À proposer ») et reçoit son temps disponible : 30 min, 1 h ou sans limite.
 *
 * Déplacer un menu : glisser sa poignée (à droite de la ligne, le geste part tout de suite) ou appui long sur le menu
 * (le téléphone vibre quand il se détache), puis glisser. Déposé sur une pastille de jour, il passe au même repas de ce
 * jour ; déposé sur l'autre repas de la carte, il change de repas. Une pastille survolée un instant ouvre son jour, pour
 * déposer le menu sur son déjeuner ou son dîner. Un repas déjà prévu à cet endroit échange sa place avec lui.
 *
 * Gestes natifs (react-native-gesture-handler) : une fois le menu détaché, le défilement de la page ne peut plus reprendre
 * le geste (avec le système de gestes de React Native, Android reprenait le doigt pour faire défiler la page et le menu
 * retombait). Le menu détaché suit le doigt par une valeur animée, sans redessiner la semaine à chaque mouvement.
 */

import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, Vibration, View, type HostInstance } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

import { dayLabel, mealLabel, minutes } from "../lib/format";
import { sourceOf, type Picture } from "../lib/images";
import { CARD_SHADOW, useColors } from "../lib/theme";
import type { WeekSlot } from "../modules/planning";
import type { MealType } from "../modules/recipes";
import { Icon } from "./icons";
import { TIME_CHOICES } from "./TimeWheel";

export interface DayPlan {
  dejeuner: boolean;
  diner: boolean;
  /** Temps disponible pour chaque repas (préparation et cuisson) ; null : sans limite. */
  time: Record<MealType, number | null>;
}

const MEALS: MealType[] = ["dejeuner", "diner"];
const SHORT_DAYS = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
/** Pastille du jour sélectionné : même dégradé que les boutons principaux de la maquette. */
const SELECTED = ["#3A5F2C", "#3C5B2D", "#385A2D"] as const;
/** Fondu de la photo d'un menu choisi vers le fond de sa ligne (#FEF3E3). */
const PHOTO_FADE = ["rgba(254,243,227,0)", "#FEF3E3"] as const;
const BAR = {
  chosen: { on: "#FFFFFF", off: "#2C5A27" },
  wanted: { on: "rgba(255,255,255,0.6)", off: "#A3AE6E" },
  free: { on: "rgba(255,255,255,0.25)", off: "#E6D6BB" },
};
/** Appui long avant de pouvoir déplacer un menu, et survol d'une pastille qui ouvre son jour. */
const HOLD_MS = 250;
const HOVER_OPEN_MS = 450;
/** Marge autour des cibles : un menu lâché juste à côté d'une pastille ou d'un repas compte. */
const SLOP = 14;
/** Le menu détaché est tenu par son quart gauche, un peu au-dessus du doigt (visible sous le pouce). */
const GHOST_DX = 60;
const GHOST_DY = 70;
const GHOST_W = 210;

const timeLabel = (t: number | null) => (t === null ? "Sans limite" : minutes(t));

/** Titre de la carte : « Aujourd'hui », « Demain » ou le jour de la semaine, puis la date (« 3 novembre »). */
function dayTitle(date: string, today: string): [string, string] {
  const [weekday, ...rest] = dayLabel(date).split(" ");
  const relative = dayLabel(date, today);
  return [relative === dayLabel(date) ? weekday! : relative, rest.join(" ")];
}

interface Rect { x: number; y: number; w: number; h: number }
type Target = { date: string; meal: MealType };
/** Menu en cours de déplacement et cible visée (la position du doigt, elle, va directement au menu détaché). */
interface Drag {
  slot: WeekSlot;
  target: Target | null;
}
interface DragHandlers {
  arm: (slot: WeekSlot, x: number, y: number) => void;
  move: (x: number, y: number) => void;
  drop: () => void;
  abort: () => void;
}

const inside = (r: Rect | undefined, x: number, y: number, dx = 0, dy = 0) =>
  Boolean(r && x >= r.x - dx && x <= r.x + r.w + dx && y >= r.y - dy && y <= r.y + r.h + dy);
const measure = (view: HostInstance | null | undefined): Promise<Rect | undefined> => new Promise((done) => {
  if (!view) return done(undefined);
  view.measureInWindow((x, y, w, h) => done({ x, y, w, h }));
});

/**
 * Menu choisi. Toucher : la fiche s'ouvre. Appui long immobile : le menu se détache (vibration) et suit le doigt ; glisser
 * tout de suite fait défiler la page. Poignée à droite : le menu se détache dès que le doigt bouge, sans appui long.
 */
function DishRow({ slot, meal, pic, busy, dimmed, aimed, onOpen, onCancel, drag }: {
  slot: WeekSlot; meal: MealType; pic: Picture | null; busy: boolean; dimmed: boolean; aimed: boolean;
  onOpen: (slot: WeekSlot) => void; onCancel: (slot: WeekSlot) => void; drag: DragHandlers | null;
}) {
  const c = useColors();
  const [pressed, setPressed] = useState(false);
  const latest = useRef({ slot, onOpen, drag });
  latest.current = { slot, onOpen, drag };

  const gestures = useMemo(() => {
    // Un même déplacement, qu'il parte de la ligne (appui long) ou de la poignée.
    let armed = false;
    const start = (x: number, y: number) => {
      if (!latest.current.drag) return;
      armed = true;
      setPressed(false);
      Vibration.vibrate(30);
      latest.current.drag.arm(latest.current.slot, x, y);
    };
    const finish = (success: boolean) => {
      if (!armed) return;
      armed = false;
      if (success) latest.current.drag?.drop();
      else latest.current.drag?.abort();
    };
    const drag = (pan: ReturnType<typeof Gesture.Pan>) => pan.runOnJS(true)
      .onStart((e) => start(e.absoluteX, e.absoluteY))
      .onUpdate((e) => { if (armed) latest.current.drag?.move(e.absoluteX, e.absoluteY); })
      .onFinalize((_e, success) => {
        setPressed(false);
        finish(success);
      });
    const hold = drag(Gesture.Pan().activateAfterLongPress(HOLD_MS)).onBegin(() => setPressed(true));
    const tap = Gesture.Tap().runOnJS(true).maxDuration(HOLD_MS + 400)
      .onEnd((_e, success) => { if (success) latest.current.onOpen(latest.current.slot); })
      .onFinalize(() => setPressed(false));
    const handle = drag(Gesture.Pan().minDistance(0)).hitSlop({ left: 6, right: 6, top: 4, bottom: 4 });
    // Le menu ne se détache que si l'appui long aboutit ; sinon un toucher bref ouvre la fiche.
    return { row: Gesture.Exclusive(hold, tap), handle };
  }, []);

  return (
    <View style={[styles.dish, { backgroundColor: c.background, borderColor: aimed ? c.accent : c.border }, aimed && styles.aimed, dimmed && { opacity: 0.35 }]}>
      <GestureDetector gesture={gestures.row}>
        <View accessible accessibilityRole="button" accessibilityLabel={`Ouvrir la fiche : ${slot.name}`}
          accessibilityHint={drag ? "Appui long puis glisser pour déplacer ce menu" : undefined}
          accessibilityActions={[{ name: "activate" }]} onAccessibilityAction={() => onOpen(slot)}
          style={[styles.dishLink, { opacity: pressed ? 0.85 : 1 }]}>
          {/* Photo transparente aux gestes : sur le web, attraper l'image lançait le glisser natif du navigateur. */}
          <View style={styles.dishPhoto} pointerEvents="none">
            {pic
              ? <Image source={sourceOf(pic, true)} placeholder={pic.fallback} placeholderContentFit="cover" cachePolicy="memory-disk"
                style={StyleSheet.absoluteFill} contentFit="cover" transition={0} />
              : <View style={[StyleSheet.absoluteFill, styles.dishWaiting, { backgroundColor: c.chip }]}><Icon name="image" size={26} color={c.muted} /></View>}
            <LinearGradient colors={PHOTO_FADE} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={styles.dishFade} />
          </View>
          <View style={styles.dishText}>
            <Text style={[styles.dishMeta, { color: c.muted }]} numberOfLines={1}>
              {mealLabel(meal)}{slot.totalMin ? ` • ${minutes(slot.totalMin)}` : ""}
            </Text>
            <Text style={[styles.dishName, { color: c.text }]} numberOfLines={2}>{slot.name}</Text>
          </View>
        </View>
      </GestureDetector>
      <Pressable onPress={() => onCancel(slot)} disabled={busy} accessibilityRole="button" accessibilityLabel={`Annuler ce menu : ${slot.name}`}
        style={({ pressed: p }) => [styles.dishClose, { opacity: p ? 0.6 : 1 }]}>
        <Icon name="cross" size={16} color={c.muted} />
      </Pressable>
      {drag ? (
        <GestureDetector gesture={gestures.handle}>
          <View style={styles.dishHandle} accessible accessibilityLabel={`Déplacer : ${slot.name}`} accessibilityHint="Glisser vers un autre jour ou un autre repas">
            <Icon name="grip" size={20} color={c.muted} />
          </View>
        </GestureDetector>
      ) : null}
    </View>
  );
}

export function WeekRibbon({ days, today, planOf, slotOf, picture, busy, onChange, onOpen, onCancel, onMove, onDragChange }: {
  days: string[]; today: string; planOf: (date: string) => DayPlan; slotOf: (date: string, meal: MealType) => WeekSlot | undefined;
  picture: (recipeId: string | null) => Picture | null; busy: boolean;
  onChange: (date: string, patch: Partial<DayPlan>) => void; onOpen: (slot: WeekSlot) => void; onCancel: (slot: WeekSlot) => void;
  /** Menu déposé ailleurs : nouveau jour et nouveau repas (échange si un menu y est déjà prévu). */
  onMove?: (slot: WeekSlot, date: string, meal: MealType) => void;
  /** Déplacement en cours : la page ne défile plus pendant ce temps. */
  onDragChange?: (dragging: boolean) => void;
}) {
  const c = useColors();
  const chosen = (d: string, m: MealType) => {
    const s = slotOf(d, m);
    return s?.status === "accepted" ? s : undefined;
  };
  // Jour affiché : celui touché, sinon le premier qui a encore un repas libre.
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked && days.includes(picked) ? picked : days.find((d) => MEALS.some((m) => !chosen(d, m))) ?? days[0]!;

  // --- Déplacement d'un menu --------------------------------------------------------------------------------------------
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  /** Position du menu détaché (dans le ruban), mise à jour sans redessiner la semaine. */
  const ghost = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const finger = useRef({ x: 0, y: 0 });
  const root = useRef<HostInstance>(null);
  const rootRect = useRef<Rect>({ x: 0, y: 0, w: 0, h: 0 });
  const chipViews = useRef(new Map<string, HostInstance | null>());
  const mealViews = useRef(new Map<MealType, HostInstance | null>());
  const chipRects = useRef(new Map<string, Rect>());
  const mealRects = useRef(new Map<MealType, Rect>());
  const hover = useRef<{ date: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const moveRef = useRef(onMove);
  moveRef.current = onMove;

  const update = (next: Drag | null) => {
    const prev = dragRef.current;
    dragRef.current = next;
    // La semaine n'est redessinée que si le menu ou la cible change (pas à chaque mouvement du doigt).
    if (prev?.slot.slotId !== next?.slot.slotId || prev?.target?.date !== next?.target?.date || prev?.target?.meal !== next?.target?.meal) setDrag(next);
  };
  const place = (x: number, y: number) => {
    finger.current = { x, y };
    // Menu détaché gardé dans la largeur de l'écran (pris par la poignée, à droite, il en sortait).
    const left = x - rootRect.current.x - GHOST_DX;
    const max = rootRect.current.w - GHOST_W;
    ghost.setValue({ x: max > 0 ? Math.max(0, Math.min(max, left)) : left, y: y - rootRect.current.y - GHOST_DY });
  };
  const measureMeals = async () => {
    for (const m of MEALS) {
      const r = await measure(mealViews.current.get(m));
      if (r) mealRects.current.set(m, r);
    }
  };
  const measureAll = async () => {
    rootRect.current = (await measure(root.current)) ?? rootRect.current;
    place(finger.current.x, finger.current.y);
    for (const [d, v] of chipViews.current) {
      const r = await measure(v);
      if (r) chipRects.current.set(d, r);
    }
    await measureMeals();
  };
  const stopHover = () => {
    if (hover.current) clearTimeout(hover.current.timer);
    hover.current = null;
  };
  const end = (drop: boolean) => {
    const d = dragRef.current;
    stopHover();
    update(null);
    onDragChange?.(false);
    if (drop && d?.target && !(d.target.date === d.slot.date && d.target.meal === d.slot.mealType)) moveRef.current?.(d.slot, d.target.date, d.target.meal);
  };
  /** Pastille sous le doigt (à quelques points près ; la plus proche si deux marges se recouvrent). */
  const chipAt = (x: number, y: number) => {
    let best: string | null = null;
    let distance = Infinity;
    for (const [day, r] of chipRects.current) {
      if (!inside(r, x, y, 4, SLOP)) continue;
      const dist = Math.abs(x - (r.x + r.w / 2));
      if (dist < distance) {
        best = day;
        distance = dist;
      }
    }
    return best;
  };
  /** Cible sous le doigt : un repas de la carte, sinon une pastille de jour (même repas que le menu déplacé). */
  const targetAt = (d: Drag, x: number, y: number): Target | null => {
    for (const m of MEALS) if (inside(mealRects.current.get(m), x, y, 4, 4)) return { date: selectedRef.current, meal: m };
    const day = chipAt(x, y);
    return day ? { date: day, meal: d.slot.mealType } : null;
  };
  const follow = (x: number, y: number) => {
    const d = dragRef.current;
    if (!d) return;
    place(x, y);
    const target = targetAt(d, x, y);
    // Pastille survolée un instant : son jour s'ouvre, pour viser son déjeuner ou son dîner.
    const chip = chipAt(x, y);
    if (chip !== hover.current?.date) {
      stopHover();
      if (chip && chip !== selectedRef.current) {
        hover.current = { date: chip, timer: setTimeout(() => {
          setPicked(chip);
          // Mesure des repas du jour ouvert, une fois affichés.
          setTimeout(() => { measureMeals().catch(() => undefined); }, 60);
        }, HOVER_OPEN_MS) };
      }
    }
    update({ ...d, target });
  };

  const arm = (slot: WeekSlot, x: number, y: number) => {
    place(x, y);
    update({ slot, target: null });
    onDragChange?.(true);
    // Positions mesurées une fois la page figée (le défilement est bloqué pendant le déplacement).
    measureAll().catch(() => undefined);
    setTimeout(() => { measureAll().catch(() => undefined); }, 80);
  };
  const dragHandlers: DragHandlers | null = onMove ? { arm, move: follow, drop: () => end(true), abort: () => end(false) } : null;
  useEffect(() => () => stopHover(), []);

  const state = (d: string, m: MealType) => (chosen(d, m) ? "chosen" : planOf(d)[m] ? "wanted" : "free");
  const summary = (d: string, m: MealType) => {
    const s = chosen(d, m);
    return `${mealLabel(m).toLowerCase()} ${s ? `choisi, ${s.name}` : planOf(d)[m] ? "à proposer" : "à prévoir"}`;
  };
  const isTarget = (t: Target) => drag?.target?.date === t.date && drag.target.meal === t.meal;
  /**
   * Carte d'un jour. Pendant un déplacement, la carte du jour d'où part le menu reste montée, invisible, quand une
   * pastille survolée ouvre un autre jour : le geste en cours est porté par la ligne du menu, qui ne doit pas disparaître
   * (sinon le menu retombait dès qu'un autre jour s'ouvrait).
   */
  const card = (day: string, visible: boolean) => {
    const [title, date] = dayTitle(day, today);
    const plan = planOf(day);
    return (
        <View key={day} pointerEvents={visible ? "auto" : "none"} accessibilityElementsHidden={!visible} importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
          style={[styles.card, { backgroundColor: c.card, borderColor: c.cardLine }, CARD_SHADOW, !visible && styles.cardKept]} accessibilityLabel={`${title}, ${date}`}>
          <View style={styles.cardHead}>
            <Text style={[styles.cardTitle, { color: day === today ? c.primary : c.text }]} accessibilityRole="header">{title}</Text>
            <Text style={[styles.cardDate, { color: c.muted }]}>{date}</Text>
          </View>

          {MEALS.map((m) => {
            const slot = chosen(day, m);
            const aimed = visible && isTarget({ date: day, meal: m });
            const dragged = drag?.slot.slotId === slot?.slotId && Boolean(slot);
            if (slot) {
              return (
                <View key={m} ref={visible ? (v) => { mealViews.current.set(m, v); } : undefined}>
                  <DishRow slot={slot} meal={m} pic={picture(slot.recipeId)} busy={busy} dimmed={dragged} aimed={aimed}
                    onOpen={onOpen} onCancel={onCancel} drag={dragHandlers} />
                </View>
              );
            }
            const on = plan[m];
            return (
              <View key={m} ref={visible ? (v) => { mealViews.current.set(m, v); } : undefined}
                style={[styles.meal, { backgroundColor: on ? c.greenSoft : c.chip, borderColor: aimed ? c.accent : on ? c.primary : "transparent" }, aimed && styles.aimed]}>
                <Pressable onPress={() => onChange(day, { [m]: !on })} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
                  accessibilityLabel={`${mealLabel(m)} du ${date}`} style={({ pressed }) => [styles.mealToggle, { opacity: pressed ? 0.8 : 1 }]}>
                  <View style={[styles.mealIcon, { backgroundColor: c.card }]}>
                    <Icon name={m === "dejeuner" ? "sun" : "moon"} size={22} color={c.greenInk} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[styles.mealName, { color: c.text }]}>{mealLabel(m)}</Text>
                    <Text style={[styles.mealSub, { color: c.muted }]}>{aimed ? "Déposer le menu ici" : on ? "À proposer" : "À prévoir"}</Text>
                  </View>
                  {on
                    ? <View style={[styles.mark, { backgroundColor: c.primary }]}><Icon name="tick" size={16} color="#FFFFFF" /></View>
                    : <View style={[styles.mark, styles.markOff, { borderColor: c.muted }]} />}
                </Pressable>
                {on ? (
                  <View style={styles.times} accessibilityRole="radiogroup" accessibilityLabel="Temps disponible">
                    <View style={{ marginRight: 6 }}><Icon name="clock" size={20} color={c.greenInk} /></View>
                    {TIME_CHOICES.map((t) => {
                      const sel = plan.time[m] === t;
                      return (
                        <Pressable key={String(t)} onPress={() => onChange(day, { time: { ...plan.time, [m]: t } })} accessibilityRole="radio"
                          accessibilityState={{ selected: sel }} accessibilityLabel={`${mealLabel(m)} : ${timeLabel(t)}`}
                          style={({ pressed }) => [styles.time, { borderColor: sel ? c.primary : "transparent", backgroundColor: sel ? c.card : "transparent", opacity: pressed ? 0.7 : 1 }]}>
                          <Text style={[styles.timeText, { color: c.text, fontWeight: sel ? "700" : "500" }]} numberOfLines={1}>{timeLabel(t)}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
              </View>
            );
          })}
          {!visible ? null : onMove && drag ? (
            <Text style={[styles.hint, { color: c.primary, fontWeight: "600" }]}>Déposez le menu sur un jour ou sur l'autre repas.</Text>
          ) : MEALS.some((m) => chosen(day, m)) && onMove ? (
            <Text style={[styles.hint, { color: c.muted }]}>Pour déplacer un menu, faites glisser sa poignée (ou appui long dessus) vers un autre jour ou un autre repas.</Text>
          ) : null}
        </View>
    );
  };
  // Jour d'où part le menu déplacé, s'il n'est plus celui affiché.
  const source = drag && drag.slot.date !== selected ? drag.slot.date : null;


  return (
    <View ref={root}>
      <View style={styles.ribbon}>
        {days.map((d) => {
          const active = d === selected;
          const isToday = d === today;
          const day = new Date(`${d}T12:00:00`);
          const [dTitle, dDate] = dayTitle(d, today);
          const ink = active ? "#FFFFFF" : isToday ? c.primary : c.text;
          const aimed = Boolean(drag?.target && drag.target.date === d);
          return (
            <Pressable key={d} ref={(v) => { chipViews.current.set(d, v as HostInstance | null); }} onPress={() => setPicked(d)}
              accessibilityRole="button" accessibilityState={{ selected: active }}
              accessibilityLabel={`${dTitle}, ${dDate} : ${summary(d, "dejeuner")}, ${summary(d, "diner")}`}
              style={({ pressed }) => [styles.day, active ? styles.dayActive : [{ backgroundColor: c.card, borderColor: isToday ? c.primary : c.cardLine }, CARD_SHADOW],
                aimed && { borderColor: c.accent, borderWidth: 2.5 }, { opacity: pressed ? 0.8 : 1 }]}>
              {active && <LinearGradient colors={SELECTED} locations={[0, 0.5, 1]} start={{ x: 0, y: 0.45 }} end={{ x: 1, y: 0.55 }} style={[StyleSheet.absoluteFill, styles.dayGradient]} />}
              <Text style={[styles.dayShort, { color: ink }]}>{SHORT_DAYS[day.getDay()]}</Text>
              <Text style={[styles.dayNumber, { color: ink }]}>{day.getDate()}</Text>
              <View style={styles.bars}>
                {MEALS.map((m) => <View key={m} style={[styles.bar, { backgroundColor: BAR[state(d, m)][active ? "on" : "off"] }]} />)}
              </View>
            </Pressable>
          );
        })}
      </View>

      {source ? card(source, false) : null}
      {card(selected, true)}

      {/* Menu en cours de déplacement : il suit le doigt. */}
      {drag ? (
        <Animated.View pointerEvents="none" style={[styles.ghost, { left: 0, top: 0, transform: ghost.getTranslateTransform(),
          backgroundColor: c.card, borderColor: drag.target ? c.accent : c.primary }]}>
          {picture(drag.slot.recipeId)
            ? <Image source={sourceOf(picture(drag.slot.recipeId)!, true)} style={styles.ghostPhoto} contentFit="cover" transition={0} />
            : null}
          <Text style={[styles.ghostText, { color: c.text }]} numberOfLines={2}>{drag.slot.name}</Text>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  ribbon: { flexDirection: "row", gap: 5, marginLeft: 12.8, marginRight: 9.2 },
  day: { flex: 1, minWidth: 0, height: 76, borderRadius: 14, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  dayActive: {
    borderColor: "transparent", shadowColor: "#3C501E", shadowOpacity: 0.3, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 3,
  },
  dayGradient: { borderRadius: 14 },
  dayShort: { fontSize: 14.2, lineHeight: 17, fontWeight: "500" },
  dayNumber: { marginTop: 1, fontSize: 20, lineHeight: 24, fontWeight: "700" },
  bars: { marginTop: 6, flexDirection: "row", gap: 3 },
  bar: { width: 16, height: 5, borderRadius: 3 },
  // Carte du jour de départ gardée pendant un déplacement : invisible et hors du flux.
  cardKept: { position: "absolute", left: 0, right: 0, top: 0, opacity: 0 },
  card: { marginTop: 10, marginLeft: 12.8, marginRight: 9.2, padding: 11, borderRadius: 17, borderWidth: 1, gap: 8 },
  cardHead: { flexDirection: "row", alignItems: "baseline", gap: 8, paddingHorizontal: 3 },
  cardTitle: { fontSize: 18, lineHeight: 24, fontWeight: "700" },
  cardDate: { fontSize: 14.2, lineHeight: 18 },
  dish: { height: 86, borderRadius: 13, borderWidth: 1, overflow: "hidden" },
  aimed: { borderWidth: 2.5 },
  dishLink: { flexDirection: "row", height: 84 },
  dishPhoto: { width: 98, height: 84 },
  dishWaiting: { alignItems: "center", justifyContent: "center" },
  dishFade: { position: "absolute", right: 0, top: 0, bottom: 0, width: 26 },
  dishText: { flex: 1, minWidth: 0, paddingLeft: 6, paddingRight: 42, justifyContent: "center" },
  dishMeta: { fontSize: 14.2, lineHeight: 18 },
  dishName: { fontSize: 15.5, lineHeight: 18.5, fontWeight: "700" },
  dishClose: { position: "absolute", right: 0, top: 0, width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  // Poignée de déplacement sous la croix, sur toute la moitié basse de la ligne.
  dishHandle: { position: "absolute", right: 0, bottom: 0, width: 48, height: 40, alignItems: "center", justifyContent: "center" },
  meal: { borderRadius: 13, borderWidth: 1.5 },
  mealToggle: { height: 60, paddingLeft: 9, paddingRight: 12, flexDirection: "row", alignItems: "center", gap: 11 },
  mealIcon: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  mealName: { fontSize: 15.5, lineHeight: 19, fontWeight: "700" },
  mealSub: { fontSize: 14.2, lineHeight: 18 },
  mark: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  markOff: { borderWidth: 2 },
  times: { flexDirection: "row", alignItems: "center", gap: 4, paddingLeft: 18, paddingRight: 8, paddingBottom: 8 },
  time: { flex: 1, minWidth: 0, height: 48, borderRadius: 12, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  timeText: { fontSize: 15 },
  hint: { fontSize: 13, lineHeight: 17, paddingHorizontal: 3 },
  ghost: {
    position: "absolute", width: GHOST_W, height: 58, borderRadius: 12, borderWidth: 2, flexDirection: "row", alignItems: "center", gap: 8,
    overflow: "hidden", zIndex: 20, elevation: 12, shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 4 },
  },
  ghostPhoto: { width: 64, height: 58 },
  ghostText: { flex: 1, fontSize: 14, lineHeight: 17, fontWeight: "700", paddingRight: 6 },
});
