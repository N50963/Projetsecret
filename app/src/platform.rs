//! Services fournis par le système : ouverture de fichiers, marges système, langue.

use std::path::PathBuf;

pub trait Platform: Send + Sync {
    /// Ouvre le sélecteur de documents du système.
    fn open_picker(&self) -> bool;
    /// Document demandé par le système (« Ouvrir avec », sélecteur), s'il y en a un.
    fn take_pending(&self) -> Option<String>;
    /// Lit un document à partir de son URI (ou chemin) : (nom affichable, contenu).
    fn read(&self, uri: &str) -> Result<(String, Vec<u8>), String>;
    /// Marges système en pixels physiques : gauche, haut, droite, bas.
    fn insets(&self) -> [f32; 4];
    /// Langue de l'appareil (ex. « fr-FR »).
    fn locale(&self) -> String;
    /// Quitte l'application.
    fn exit(&self);
    /// Dossier de données privé de l'application.
    fn data_dir(&self) -> Option<PathBuf>;
    fn has_picker(&self) -> bool {
        true
    }
}

// --------------------------------------------------------------------------------
// Bureau (tests, développement)
// --------------------------------------------------------------------------------

pub struct DesktopPlatform {
    pub pending: std::sync::Mutex<Vec<String>>,
}

impl Platform for DesktopPlatform {
    fn open_picker(&self) -> bool {
        false
    }
    fn take_pending(&self) -> Option<String> {
        self.pending.lock().unwrap().pop()
    }
    fn read(&self, uri: &str) -> Result<(String, Vec<u8>), String> {
        let path = uri.strip_prefix("file://").unwrap_or(uri);
        let data = std::fs::read(path).map_err(|e| format!("Lecture impossible : {e}"))?;
        let name = std::path::Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or("Document").to_string();
        Ok((name, data))
    }
    fn insets(&self) -> [f32; 4] {
        [0.0; 4]
    }
    fn locale(&self) -> String {
        std::env::var("LANG").unwrap_or_else(|_| "fr_FR".into()).replace('_', "-")
    }
    fn exit(&self) {
        std::process::exit(0);
    }
    fn data_dir(&self) -> Option<PathBuf> {
        let base = std::env::var("XDG_DATA_HOME").map(PathBuf::from).or_else(|_| std::env::var("HOME").map(|h| PathBuf::from(h).join(".local/share"))).ok()?;
        let d = base.join("lecteur-office");
        std::fs::create_dir_all(&d).ok()?;
        Some(d)
    }
    fn has_picker(&self) -> bool {
        false
    }
}

// --------------------------------------------------------------------------------
// Android (JNI vers MainActivity.java)
// --------------------------------------------------------------------------------

#[cfg(target_os = "android")]
pub mod android {
    use super::Platform;
    use jni::objects::{JIntArray, JObject, JString, JValue};
    use jni::JavaVM;
    use std::io::Read;
    use std::os::fd::FromRawFd;
    use std::path::PathBuf;

    pub struct AndroidPlatform {
        vm: JavaVM,
        activity: usize,
        data_dir: Option<PathBuf>,
    }

    // L'objet activité est une référence globale JNI, utilisable depuis tout thread attaché.
    unsafe impl Send for AndroidPlatform {}
    unsafe impl Sync for AndroidPlatform {}

    impl AndroidPlatform {
        pub fn new(app: &winit::platform::android::activity::AndroidApp) -> Option<AndroidPlatform> {
            let vm = unsafe { JavaVM::from_raw(app.vm_as_ptr() as *mut jni::sys::JavaVM) }.ok()?;
            Some(AndroidPlatform { vm, activity: app.activity_as_ptr() as usize, data_dir: app.internal_data_path() })
        }

        fn call<R>(&self, f: impl FnOnce(&mut jni::JNIEnv, &JObject) -> jni::errors::Result<R>) -> Option<R> {
            let mut env = self.vm.attach_current_thread().ok()?;
            let act = unsafe { JObject::from_raw(self.activity as jni::sys::jobject) };
            let r = f(&mut env, &act);
            if env.exception_check().unwrap_or(false) {
                let _ = env.exception_describe();
                let _ = env.exception_clear();
            }
            match r {
                Ok(v) => Some(v),
                Err(e) => {
                    log::warn!("JNI : {e}");
                    None
                }
            }
        }
    }

    fn jstring_to_string(env: &mut jni::JNIEnv, o: JObject) -> Option<String> {
        if o.is_null() {
            return None;
        }
        let js = JString::from(o);
        env.get_string(&js).ok().map(|s| s.into())
    }

    impl Platform for AndroidPlatform {
        fn open_picker(&self) -> bool {
            self.call(|env, act| env.call_method(act, "openDocumentPicker", "()V", &[]).map(|_| ())).is_some()
        }

        fn take_pending(&self) -> Option<String> {
            self.call(|env, act| {
                let o = env.call_method(act, "takePendingUri", "()Ljava/lang/String;", &[])?.l()?;
                Ok(jstring_to_string(env, o))
            })
            .flatten()
        }

        fn read(&self, uri: &str) -> Result<(String, Vec<u8>), String> {
            let res = self.call(|env, act| {
                let ju = env.new_string(uri)?;
                let fd = env.call_method(act, "openFd", "(Ljava/lang/String;)I", &[JValue::Object(&ju)])?.i()?;
                let name_obj = env.call_method(act, "displayName", "(Ljava/lang/String;)Ljava/lang/String;", &[JValue::Object(&ju)])?.l()?;
                let name = jstring_to_string(env, name_obj).unwrap_or_else(|| "Document".into());
                Ok((fd, name))
            });
            let (fd, name) = res.ok_or("Accès au document impossible.")?;
            if fd < 0 {
                return Err("Le document ne peut pas être ouvert (autorisation refusée ou fichier introuvable).".into());
            }
            let mut f = unsafe { std::fs::File::from_raw_fd(fd) };
            let mut data = Vec::new();
            f.read_to_end(&mut data).map_err(|e| format!("Lecture impossible : {e}"))?;
            Ok((name, data))
        }

        fn insets(&self) -> [f32; 4] {
            self.call(|env, act| {
                let arr = env.call_method(act, "getInsets", "()[I", &[])?.l()?;
                let arr = JIntArray::from(arr);
                let mut buf = [0i32; 4];
                env.get_int_array_region(&arr, 0, &mut buf)?;
                Ok([buf[0] as f32, buf[1] as f32, buf[2] as f32, buf[3] as f32])
            })
            .unwrap_or([0.0, 80.0, 0.0, 60.0])
        }

        fn locale(&self) -> String {
            self.call(|env, act| {
                let o = env.call_method(act, "localeTag", "()Ljava/lang/String;", &[])?.l()?;
                Ok(jstring_to_string(env, o))
            })
            .flatten()
            .unwrap_or_else(|| "fr-FR".into())
        }

        fn exit(&self) {
            let _ = self.call(|env, act| env.call_method(act, "exitApp", "()V", &[]).map(|_| ()));
        }

        fn data_dir(&self) -> Option<PathBuf> {
            self.data_dir.clone()
        }
    }
}
