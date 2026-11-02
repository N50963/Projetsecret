/**
 * Sources d'une recette à importer : pages photographiées (réduites avant l'envoi) et enregistrement de la voix (lu en
 * base64). La lecture et la mise en forme se font dans la fonction serveur « mistral » (import_photo, import_audio).
 */
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { Platform } from "react-native";

/** Page de recette prête à envoyer : aperçu local et JPEG en base64 (1 600 px de large au plus, lisible et léger). */
export interface RecipePage {
  uri: string;
  base64: string;
}

const PAGE_WIDTH = 1600;
export const MAX_PAGES = 4;

async function asPage(uri: string, width?: number): Promise<RecipePage> {
  const context = ImageManipulator.manipulate(uri);
  if (!width || width > PAGE_WIDTH) context.resize({ width: PAGE_WIDTH, height: null });
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.7, base64: true });
  if (!saved.base64) throw new Error("Photo illisible : reprenez-la.");
  return { uri: saved.uri, base64: saved.base64 };
}

/** Photographie la recette (appareil photo) ou choisit ses pages dans la galerie (plusieurs à la fois). */
export async function pickRecipePages(camera: boolean, max: number): Promise<RecipePage[]> {
  if (camera && !(await ImagePicker.requestCameraPermissionsAsync()).granted) {
    throw new Error("Accès à l'appareil photo refusé : autorisez-le dans les réglages du téléphone.");
  }
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.85, allowsMultipleSelection: !camera, selectionLimit: max };
  const result = camera ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  if (result.canceled) return [];
  return Promise.all(result.assets.slice(0, max).map((a) => asPage(a.uri, a.width)));
}

/** Enregistrement de la voix en base64, avec son type (m4a sur le téléphone, webm dans un navigateur). */
export async function readRecording(uri: string): Promise<{ base64: string; mime: string }> {
  if (Platform.OS === "web") {
    const blob = await (await fetch(uri)).blob();
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]+,/, ""));
      reader.onerror = () => reject(new Error("Enregistrement illisible."));
      reader.readAsDataURL(blob);
    });
    return { base64, mime: blob.type || "audio/webm" };
  }
  return { base64: await new File(uri).base64(), mime: uri.endsWith(".3gp") ? "audio/3gpp" : "audio/mp4" };
}
