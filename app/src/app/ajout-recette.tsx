import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder, useAudioRecorderState, type RecordingOptions } from "expo-audio";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Icon } from "../components/icons";
import { cleanDraft, RecipeEditor } from "../components/RecipeEditor";
import { Button, Card, Chip, ErrorText, H2, Muted, Row, Screen } from "../components/ui";
import { uploadRecipePhoto } from "../lib/images";
import { draftToInput, illustrateRecipe, importAudio, importPhoto, importRecipe, importUrl, type ImportedDraft } from "../lib/mistral";
import { MAX_PAGES, pickRecipePages, readRecording, type RecipePage } from "../lib/recipeImport";
import { pickDishPhoto, type PickedPhoto } from "../lib/photo";
import { useHousehold } from "../lib/session";
import { supabase } from "../lib/supabase";
import { useColors } from "../lib/theme";
import { createRecipe, validateRecipe } from "../modules/recipes";
import { errorText } from "../lib/errors";

/** Photo du plat, facultative : appareil photo ou galerie. Sans photo, Mistral crée une illustration. */
function PhotoPicker({ photo, onChange, onError }: { photo: PickedPhoto | null; onChange: (p: PickedPhoto | null) => void; onError: (m: string) => void }) {
  const c = useColors();
  const pick = (camera: boolean) => pickDishPhoto(camera).then((p) => p && onChange(p), (e) => onError(errorText(e)));
  return (
    <Card>
      <H2>Photo du plat</H2>
      {photo ? (
        <View>
          <Image source={{ uri: photo.uri }} style={styles.photo} contentFit="cover" />
          <Pressable onPress={() => onChange(null)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Retirer la photo"
            style={[styles.remove, { backgroundColor: c.card }]}>
            <Icon name="close" size={20} color={c.text} />
          </Pressable>
        </View>
      ) : (
        <Muted>Facultatif : sans photo, une illustration du plat est créée automatiquement. Vous pourrez la remplacer plus tard.</Muted>
      )}
      <Row>
        <Button title={photo ? "Reprendre" : "Prendre une photo"} kind="secondary" onPress={() => pick(true)} style={{ flex: 1 }} />
        <Button title="Galerie" kind="secondary" onPress={() => pick(false)} style={{ flex: 1 }} />
      </Row>
    </Card>
  );
}

type Mode = "photo" | "lien" | "voix" | "coller" | "saisir";
const MODES: Array<{ mode: Mode; label: string; icon: "camera" | "link" | "mic" | "receipt" | "book" }> = [
  { mode: "photo", label: "Photo", icon: "camera" }, { mode: "lien", label: "Lien internet", icon: "link" },
  { mode: "voix", label: "À voix haute", icon: "mic" }, { mode: "coller", label: "Coller un texte", icon: "receipt" },
  { mode: "saisir", label: "Saisir", icon: "book" },
];
/** Enregistrement de la voix : mono, 16 kHz, 32 kb/s (8 minutes ≈ 2 Mo), assez pour une transcription fidèle. */
const VOICE: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY, extension: ".m4a", sampleRate: 16000, numberOfChannels: 1, bitRate: 32000,
  android: { extension: ".m4a", outputFormat: "mpeg4", audioEncoder: "aac", sampleRate: 16000 },
  // Navigateur : le débit annoncé est partagé avec une piste vidéo absente (le son en reçoit le dixième).
  web: { mimeType: "audio/webm", bitsPerSecond: 320000 },
};
const MAX_RECORDING_MS = 8 * 60 * 1000;
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

/**
 * Ajouter une recette : photo de la recette (livre, fiche, écran, manuscrit, jusqu'à 4 pages), lien de la page internet,
 * lecture à voix haute (transcrite), texte collé ou saisie libre. Mistral lit la source et met la recette en forme
 * (durées et minuteurs compris) ; l'utilisateur la relit et la corrige, il a le dernier mot ; photo du plat facultative.
 */
export default function AjoutRecette() {
  const router = useRouter();
  const household = useHousehold();
  const c = useColors();
  const [mode, setMode] = useState<Mode>("photo");
  const [pages, setPages] = useState<RecipePage[]>([]);
  const [url, setUrl] = useState("");
  const recorder = useAudioRecorder(VOICE);
  const recording = useAudioRecorderState(recorder, 250);
  const [voice, setVoice] = useState<{ uri: string; ms: number } | null>(null);
  /** Ce que Mistral a lu (photo, page) ou entendu (voix), montré sous le brouillon. */
  const [sourceText, setSourceText] = useState("");
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [time, setTime] = useState("");
  const [ingredients, setIngredients] = useState("");
  const [steps, setSteps] = useState("");
  const [photo, setPhoto] = useState<PickedPhoto | null>(null);
  const [draft, setDraft] = useState<ImportedDraft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const input = [styles.input, { borderColor: c.field, color: c.text, backgroundColor: c.card }];

  const source = mode === "coller" ? text
    : `${name}\nTemps : ${time}\nIngrédients pour ${household.defaultServings} personnes :\n${ingredients}\nÉtapes :\n${steps}`;

  /** Lecture de la source choisie par Mistral, puis brouillon à relire. */
  const format = async () => {
    setBusy("format");
    setError("");
    try {
      const servings = household.defaultServings;
      let result: ImportedDraft;
      if (mode === "photo") result = await importPhoto(household.id, pages.map((p) => p.base64), servings);
      else if (mode === "lien") result = await importUrl(household.id, url.trim(), servings);
      else if (mode === "voix") {
        const audio = await readRecording(voice!.uri);
        result = await importAudio(household.id, audio.base64, audio.mime, servings);
      } else result = await importRecipe(household.id, source, servings);
      setSourceText(result.source_text ?? "");
      setDraft(result);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const addPages = (camera: boolean) => {
    setError("");
    pickRecipePages(camera, MAX_PAGES - pages.length)
      .then((more) => setPages((p) => [...p, ...more].slice(0, MAX_PAGES)), (e) => setError(errorText(e)));
  };

  const startRecording = async () => {
    setError("");
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error("Accès au micro refusé : autorisez-le dans les réglages du téléphone.");
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      setVoice(null);
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const stopRecording = async () => {
    const ms = recording.durationMillis;
    await recorder.stop();
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined);
    if (recorder.uri) setVoice({ uri: recorder.uri, ms });
  };
  // Enregistrement arrêté de lui-même au bout de 8 minutes.
  useEffect(() => {
    if (recording.isRecording && recording.durationMillis >= MAX_RECORDING_MS) stopRecording().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording.durationMillis, recording.isRecording]);

  const ready = mode === "photo" ? pages.length > 0 : mode === "lien" ? /^https?:\/\/\S+\.\S+/.test(url.trim())
    : mode === "voix" ? Boolean(voice) && !recording.isRecording : source.trim().length >= 40;

  const save = async () => {
    if (!draft) return;
    const recipe = draftToInput(cleanDraft(draft.recipe),
      mode === "photo" ? "import_photo" : mode === "lien" ? "import_url" : mode === "saisir" ? "manual" : "import_text");
    const issues = validateRecipe(recipe);
    if (issues.length) {
      setError(`À corriger : ${issues.map((i) => i.message).join(" ; ")}`);
      return;
    }
    setBusy("save");
    setError("");
    try {
      const id = await createRecipe(supabase, household.id, recipe);
      if (photo) {
        try {
          await uploadRecipePhoto(household.id, id, photo.uri, photo.width);
        } catch {
          // La recette est enregistrée ; la photo pourra être remise depuis sa fiche.
          illustrateRecipe(household.id, id).catch(() => undefined);
        }
      } else {
        illustrateRecipe(household.id, id).catch(() => undefined);
      }
      router.replace(`/recette/${id}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  if (draft) {
    return (
      <Screen title="Vérifier la recette">
        <Muted>
          Après réflexion approfondie, la recette est mise en forme et les durées de cuisson sont précisées. Vous avez le dernier
          mot : corrigez ce que vous voulez, c'est votre version qui sera enregistrée.
        </Muted>
        {draft.issues.length ? <Muted>Points à vérifier : {draft.issues.join(" ; ")}</Muted> : null}
        {sourceText ? <SourceText mode={mode} text={sourceText} /> : null}
        <RecipeEditor value={draft.recipe} onChange={(r) => setDraft({ ...draft, recipe: r })} />
        <PhotoPicker photo={photo} onChange={setPhoto} onError={setError} />
        <ErrorText>{error}</ErrorText>
        <Button title="Enregistrer la recette" onPress={save} busy={busy === "save"} />
        <Button title={mode === "photo" ? "Revenir aux photos" : mode === "lien" ? "Revenir au lien" : mode === "voix" ? "Revenir à l'enregistrement" : "Revenir au texte"}
          kind="secondary" onPress={() => setDraft(null)} />
      </Screen>
    );
  }

  return (
    <Screen title="Ajouter une recette">
      <Muted>D'où vient la recette ?</Muted>
      <Row>
        {MODES.map((m) => <Chip key={m.mode} label={m.label} icon={m.icon} active={mode === m.mode} onPress={() => setMode(m.mode)} />)}
      </Row>
      {mode === "photo" ? (
        <View style={{ gap: 10 }}>
          <Muted>Photographiez la recette (livre, fiche, écran, papier manuscrit), jusqu'à {MAX_PAGES} pages : le texte est lu puis mis en forme.</Muted>
          {pages.length ? (
            <View style={styles.pages}>
              {pages.map((p, n) => (
                <View key={p.uri}>
                  <Image source={{ uri: p.uri }} style={[styles.page, { borderColor: c.border }]} contentFit="cover" />
                  <Text style={[styles.pageNumber, { backgroundColor: c.card, color: c.text }]}>{n + 1}</Text>
                  <Pressable onPress={() => setPages((list) => list.filter((x) => x.uri !== p.uri))} hitSlop={8} accessibilityRole="button"
                    accessibilityLabel={`Retirer la page ${n + 1}`} style={[styles.pageRemove, { backgroundColor: c.card }]}>
                    <Icon name="close" size={16} color={c.text} />
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}
          {pages.length < MAX_PAGES ? (
            <Row>
              <Button title={pages.length ? "Page suivante" : "Prendre une photo"} icon="camera" kind="secondary" onPress={() => addPages(true)} style={{ flex: 1.4 }} />
              <Button title="Galerie" icon="gallery" kind="secondary" onPress={() => addPages(false)} style={{ flex: 1 }} />
            </Row>
          ) : null}
        </View>
      ) : mode === "lien" ? (
        <View style={{ gap: 10 }}>
          <Muted>Collez l'adresse de la page de la recette (Marmiton, 750g, un blog…) : MenuBily la lit et la met en forme.</Muted>
          <TextInput value={url} onChangeText={setUrl} placeholder="https://…" placeholderTextColor={c.muted} style={input}
            autoCapitalize="none" autoCorrect={false} keyboardType="url" inputMode="url" accessibilityLabel="Adresse de la page de la recette" />
        </View>
      ) : mode === "voix" ? (
        <View style={{ gap: 12 }}>
          <Muted>Lisez la recette à voix haute : son nom, les ingrédients avec leurs quantités, puis les étapes. MenuBily l'écoute, la transcrit et la met en forme (8 minutes au plus).</Muted>
          <View style={[styles.recorder, { backgroundColor: c.card, borderColor: recording.isRecording ? c.danger : c.cardLine }]}>
            <Pressable onPress={recording.isRecording ? stopRecording : startRecording} accessibilityRole="button"
              accessibilityLabel={recording.isRecording ? "Arrêter l'enregistrement" : voice ? "Recommencer l'enregistrement" : "Commencer l'enregistrement"}
              style={({ pressed }) => [styles.recordButton, { backgroundColor: recording.isRecording ? c.danger : c.primary, opacity: pressed ? 0.8 : 1 }]}>
              <Icon name={recording.isRecording ? "stop" : "mic"} size={34} color="#FFFFFF" />
            </Pressable>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: c.text, fontSize: 17, fontWeight: "700" }}>
                {recording.isRecording ? "J'écoute…" : voice ? "Recette enregistrée" : "Touchez le micro pour commencer"}
              </Text>
              <Text style={{ color: recording.isRecording ? c.danger : c.muted, fontSize: 15, fontVariant: ["tabular-nums"] }}>
                {recording.isRecording ? `${clock(recording.durationMillis)} · touchez pour arrêter` : voice ? `${clock(voice.ms)} · touchez le micro pour recommencer` : "Parlez près du téléphone"}
              </Text>
            </View>
          </View>
        </View>
      ) : mode === "coller" ? (
        <>
          <Muted>Collez la recette (site, message, livre) : elle est mise en forme et ses ingrédients sont reliés à vos achats.</Muted>
          <TextInput multiline value={text} onChangeText={setText} placeholder="Coller ici" placeholderTextColor={c.muted}
            style={[input, { minHeight: 220 }]} />
        </>
      ) : (
        <View style={{ gap: 10 }}>
          <TextInput value={name} onChangeText={setName} placeholder="Nom du plat" placeholderTextColor={c.muted} style={input} />
          <TextInput value={time} onChangeText={setTime} placeholder="Temps (ex. 15 min de préparation, 30 min de cuisson)" placeholderTextColor={c.muted} style={input} />
          <TextInput multiline value={ingredients} onChangeText={setIngredients} placeholder={"Ingrédients, un par ligne\n600 g de poulet\n2 courgettes"}
            placeholderTextColor={c.muted} style={[input, { minHeight: 120 }]} />
          <TextInput multiline value={steps} onChangeText={setSteps} placeholder={"Étapes, une par ligne, avec les durées\nCuire le riz 11 min"}
            placeholderTextColor={c.muted} style={[input, { minHeight: 120 }]} />
        </View>
      )}
      <ErrorText>{error}</ErrorText>
      <Button title={mode === "photo" ? "Lire la recette" : mode === "lien" ? "Importer la recette" : mode === "voix" ? "Transcrire la recette" : "Mettre en forme"}
        icon="wand" onPress={format} busy={busy === "format"} disabled={!ready || busy !== null} />
      {busy === "format" ? (
        <View style={styles.waiting}>
          <ActivityIndicator color={c.primary} />
          <Muted style={{ flex: 1 }}>
            {mode === "photo" ? "Réflexion approfondie : lecture de la photo puis mise en forme (30 s environ)…" : mode === "lien" ? "Réflexion approfondie : lecture de la page et mise en forme (20 s environ)…"
              : mode === "voix" ? "Réflexion approfondie : transcription de votre voix puis mise en forme (20 s environ)…" : "Réflexion approfondie : mise en forme de la recette…"}
          </Muted>
        </View>
      ) : null}
      <Text style={{ color: c.muted, fontSize: 14, lineHeight: 20 }}>
        Vous relirez et corrigerez la recette avant de l'enregistrer ; chaque étape avec une durée aura son minuteur.
      </Text>
    </Screen>
  );
}

/** Texte lu (photo, page) ou entendu (voix) par Mistral, repliable : pour vérifier qu'il n'a rien oublié. */
function SourceText({ mode, text }: { mode: Mode; text: string }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  return (
    <View style={[styles.source, { backgroundColor: c.card, borderColor: c.cardLine }]}>
      <Pressable onPress={() => setOpen((o) => !o)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.sourceHead}>
        <Icon name={mode === "voix" ? "mic" : mode === "lien" ? "link" : "camera"} size={18} color={c.muted} />
        <Text style={{ flex: 1, color: c.text, fontSize: 15, fontWeight: "600" }}>
          {mode === "voix" ? "Ce que MenuBily a entendu" : mode === "lien" ? "Ce que MenuBily a lu sur la page" : "Ce que MenuBily a lu sur la photo"}
        </Text>
        <Icon name={open ? "chevronUp" : "chevronDown"} size={18} color={c.text} />
      </Pressable>
      {open ? <Text style={{ color: c.muted, fontSize: 14.5, lineHeight: 20 }}>{text}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pages: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  page: { width: 96, height: 128, borderRadius: 10, borderWidth: 1 },
  pageNumber: { position: "absolute", left: 6, bottom: 6, minWidth: 22, borderRadius: 11, textAlign: "center", fontSize: 13, fontWeight: "700", overflow: "hidden" },
  pageRemove: { position: "absolute", top: 4, right: 4, width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  recorder: { flexDirection: "row", alignItems: "center", gap: 16, borderRadius: 16, borderWidth: 1.5, padding: 14 },
  recordButton: { width: 68, height: 68, borderRadius: 34, alignItems: "center", justifyContent: "center" },
  waiting: { flexDirection: "row", alignItems: "center", gap: 10 },
  source: { borderRadius: 12, borderWidth: 1, padding: 12, gap: 8 },
  sourceHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  input: { minHeight: 48, borderRadius: 13, borderWidth: 1.5, padding: 12, fontSize: 16, textAlignVertical: "top" },
  photo: { width: "100%", height: 200, borderRadius: 12 },
  remove: { position: "absolute", top: 8, right: 8, width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
});
