use serde::Serialize;
use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "jpe", "jfif", "png", "gif", "bmp", "webp", "tif", "tiff", "ico", "avif",
    "svg",
];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ImageInfo {
    path: String,
    name: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LoadResult {
    folder: String,
    images: Vec<ImageInfo>,
    initial_index: usize,
    /// true = 单张图片模式, false = 文件夹模式
    single: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LaunchTarget {
    path: String,
    is_dir: bool,
}

#[derive(Default)]
struct LaunchState {
    target: Mutex<Option<LaunchTarget>>,
}

fn is_image_file(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => IMAGE_EXTS.contains(&ext.to_ascii_lowercase().as_str()),
        None => false,
    }
}

/// 自然排序：img2.jpg 排在 img10.jpg 前面
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let a = a.to_lowercase();
    let b = b.to_lowercase();
    let ac: Vec<char> = a.chars().collect();
    let bc: Vec<char> = b.chars().collect();
    let (mut i, mut j) = (0usize, 0usize);
    while i < ac.len() && j < bc.len() {
        if ac[i].is_ascii_digit() && bc[j].is_ascii_digit() {
            let (si, sj) = (i, j);
            while i < ac.len() && ac[i].is_ascii_digit() {
                i += 1;
            }
            while j < bc.len() && bc[j].is_ascii_digit() {
                j += 1;
            }
            let na: String = ac[si..i].iter().collect();
            let nb: String = bc[sj..j].iter().collect();
            let na = na.trim_start_matches('0');
            let nb = nb.trim_start_matches('0');
            match na.len().cmp(&nb.len()) {
                Ordering::Equal => {}
                o => return o,
            }
            match na.cmp(nb) {
                Ordering::Equal => {}
                o => return o,
            }
        } else {
            match ac[i].cmp(&bc[j]) {
                Ordering::Equal => {
                    i += 1;
                    j += 1;
                }
                o => return o,
            }
        }
    }
    (ac.len() - i).cmp(&(bc.len() - j))
}

#[tauri::command]
fn take_launch_target(state: tauri::State<'_, LaunchState>) -> Option<LaunchTarget> {
    state.target.lock().unwrap().take()
}

#[tauri::command]
fn load_images(path: String) -> Result<LoadResult, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("路径不存在：{}", path));
    }

    if p.is_file() {
        if !is_image_file(&p) {
            return Err(format!("不支持的图片格式：{}", path));
        }
        // 打开单张图片时，同样加载其所在文件夹的全部图片，这样可以翻页浏览。
        let folder = p
            .parent()
            .map(|v| v.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        let target = p.to_string_lossy().into_owned();

        let mut images: Vec<ImageInfo> = Vec::new();
        let entries = std::fs::read_dir(&folder).map_err(|e| format!("无法读取文件夹：{}", e))?;
        for entry in entries.flatten() {
            let ep = entry.path();
            if !ep.is_file() || !is_image_file(&ep) {
                continue;
            }
            images.push(ImageInfo {
                path: ep.to_string_lossy().into_owned(),
                name: entry.file_name().to_string_lossy().into_owned(),
            });
        }
        images.sort_by(|a, b| natural_cmp(&a.name, &b.name));

        // 定位到用户打开的那张图片
        let initial_index = images
            .iter()
            .position(|im| im.path == target)
            .unwrap_or(0);

        return Ok(LoadResult {
            folder: folder.to_string_lossy().into_owned(),
            images,
            initial_index,
            single: false,
        });
    }

    let mut images: Vec<ImageInfo> = Vec::new();
    let entries = std::fs::read_dir(&p).map_err(|e| format!("无法读取文件夹：{}", e))?;
    for entry in entries.flatten() {
        let ep = entry.path();
        if !ep.is_file() || !is_image_file(&ep) {
            continue; // 明确不包含子文件夹
        }
        images.push(ImageInfo {
            path: ep.to_string_lossy().into_owned(),
            name: entry.file_name().to_string_lossy().into_owned(),
        });
    }
    images.sort_by(|a, b| natural_cmp(&a.name, &b.name));

    Ok(LoadResult {
        folder: p.to_string_lossy().into_owned(),
        images,
        initial_index: 0,
        single: false,
    })
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = std::process::Command::new("explorer.exe");
        cmd.arg(format!("/select,\"{}\"", path))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let _ = path;
    }
    Ok(())
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("explorer.exe")
            .arg(&path)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let _ = path;
    }
    Ok(())
}

/// 把文本写入系统剪贴板（Windows 原生 API，不引入额外依赖）
#[tauri::command]
fn write_clipboard(text: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::ffi::c_void;
        use std::os::windows::ffi::OsStrExt;
        use std::ptr;

        #[link(name = "user32")]
        extern "system" {
            fn OpenClipboard(h_wnd_new_owner: *mut c_void) -> i32;
            fn CloseClipboard() -> i32;
            fn EmptyClipboard() -> i32;
            fn SetClipboardData(u_format: u32, h_mem: *mut c_void) -> *mut c_void;
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GlobalAlloc(u_flags: u32, dw_bytes: usize) -> *mut c_void;
            fn GlobalLock(h_mem: *mut c_void) -> *mut c_void;
            fn GlobalUnlock(h_mem: *mut c_void) -> i32;
            fn GlobalFree(h_mem: *mut c_void) -> *mut c_void;
        }

        const CF_UNICODETEXT: u32 = 13;
        const GMEM_MOVEABLE: u32 = 0x0002;

        let wide: Vec<u16> = std::ffi::OsStr::new(&text)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let byte_len = wide.len() * std::mem::size_of::<u16>();

        unsafe {
            if OpenClipboard(ptr::null_mut()) == 0 {
                return Err("无法打开系统剪贴板".into());
            }
            if EmptyClipboard() == 0 {
                CloseClipboard();
                return Err("无法清空系统剪贴板".into());
            }
            let h_mem = GlobalAlloc(GMEM_MOVEABLE, byte_len);
            if h_mem.is_null() {
                CloseClipboard();
                return Err("分配剪贴板内存失败".into());
            }
            let locked = GlobalLock(h_mem);
            if locked.is_null() {
                GlobalFree(h_mem);
                CloseClipboard();
                return Err("锁定剪贴板内存失败".into());
            }
            ptr::copy_nonoverlapping(wide.as_ptr(), locked as *mut u16, wide.len());
            GlobalUnlock(h_mem);

            let ok = !SetClipboardData(CF_UNICODETEXT, h_mem).is_null();
            if !ok {
                GlobalFree(h_mem);
            }
            CloseClipboard();
            if !ok {
                return Err("写入剪贴板失败".into());
            }
        }
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        let _ = text;
        Err("当前平台不支持原生剪贴板写入".into())
    }
}

/// 把当前图片复制到指定文件夹；同名文件自动追加 " (1)"、" (2)" …
#[tauri::command]
fn copy_image_to_folder(source: String, dest_folder: String) -> Result<String, String> {
    let src = PathBuf::from(&source);
    if !src.is_file() {
        return Err(format!("源文件不存在：{}", source));
    }
    let dir = PathBuf::from(&dest_folder);
    if !dir.is_dir() {
        return Err(format!("目标文件夹不存在：{}", dest_folder));
    }

    let file_name = src
        .file_name()
        .ok_or_else(|| "无法获取源文件名".to_string())?;
    let mut dest = dir.join(file_name);

    if dest.exists() {
        let stem = src
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("image")
            .to_string();
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_string();
        let mut n = 1usize;
        loop {
            let name = if ext.is_empty() {
                format!("{} ({})", stem, n)
            } else {
                format!("{} ({}).{}", stem, n, ext)
            };
            let candidate = dir.join(&name);
            if !candidate.exists() {
                dest = candidate;
                break;
            }
            n += 1;
        }
    }

    std::fs::copy(&src, &dest).map_err(|e| format!("复制失败：{}", e))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// 决定「复制到文件夹」的初始目录：
/// 上次使用过的目录若仍存在且可读取，则原样返回；否则返回空串，由前端回退到当前图片所在文件夹。
#[tauri::command]
fn get_copy_default_folder(last_folder: String) -> String {
    if !last_folder.trim().is_empty() {
        let p = PathBuf::from(&last_folder);
        if p.is_dir() && std::fs::read_dir(&p).is_ok() {
            return last_folder;
        }
    }
    String::new()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IntegrationStatus {
    default_registered: bool,
    context_menu: bool,
    exe_path: String,
}

fn current_exe_string() -> String {
    std::env::current_exe()
        .unwrap_or_else(|_| PathBuf::from("QuickView.exe"))
        .to_string_lossy()
        .into_owned()
}

#[cfg(windows)]
fn reg_classes() -> winreg::RegKey {
    winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
}

#[cfg(windows)]
fn reg_open_or_create(path: &str) -> std::io::Result<winreg::RegKey> {
    let (key, _) = reg_classes().create_subkey(path)?;
    Ok(key)
}

#[tauri::command]
fn get_integration_status() -> IntegrationStatus {
    let exe_path = current_exe_string();
    #[cfg(windows)]
    {
        let default_registered = reg_classes()
            .open_subkey("Software\\Classes\\QuickView.Image\\shell\\open\\command")
            .is_ok();
        let context_menu = reg_classes()
            .open_subkey("Software\\Classes\\Directory\\shell\\QuickViewBrowse")
            .is_ok();
        return IntegrationStatus {
            default_registered,
            context_menu,
            exe_path,
        };
    }
    #[cfg(not(windows))]
    {
        return IntegrationStatus {
            default_registered: false,
            context_menu: false,
            exe_path,
        };
    }
}

/// 注册为图片默认查看程序（当前用户）。
/// Windows 10/11 的 UserChoice 带签名校验，程序无法静默改写；
/// 这里注册 ProgID + OpenWithProgids + 扩展名默认值，使其出现在“打开方式/默认应用”中，
/// 前端随后引导用户到系统设置里最终确认。
#[tauri::command]
fn register_default_viewer() -> Result<(), String> {
    #[cfg(windows)]
    {
        let exe = current_exe_string();
        let prog_id = "QuickView.Image";
        let open_cmd = format!("\"{}\" \"%1\"", exe);

        // ProgID 与打开命令
        let prog = reg_open_or_create("Software\\Classes\\QuickView.Image")
            .map_err(|e| e.to_string())?;
        prog.set_value("", &"快看看图 图片文件")
            .map_err(|e| e.to_string())?;
        prog.set_value("FriendlyTypeName", &"快看看图 图片文件")
            .map_err(|e| e.to_string())?;
        prog.set_value("EditFlags", &2u32).map_err(|e| e.to_string())?;

        let (icon, _) = prog
            .create_subkey("DefaultIcon")
            .map_err(|e| e.to_string())?;
        icon.set_value("", &format!("\"{}\",0", exe))
            .map_err(|e| e.to_string())?;

        let open = reg_open_or_create("Software\\Classes\\QuickView.Image\\shell\\open\\command")
            .map_err(|e| e.to_string())?;
        open.set_value("", &open_cmd).map_err(|e| e.to_string())?;

        // 各扩展名：OpenWithProgids + 默认值 + Explorer OpenWithList
        for ext in IMAGE_EXTS {
            let ext_key = format!("Software\\Classes\\.{}", ext);
            let key = reg_open_or_create(&ext_key).map_err(|e| e.to_string())?;
            // 仅当没有默认值时才写入，避免破坏用户已有其他程序关联
            let current: String = key.get_value("").unwrap_or_default();
            if current.trim().is_empty() {
                let _ = key.set_value("", &prog_id);
            }
            let (ow, _) = key
                .create_subkey("OpenWithProgids")
                .map_err(|e| e.to_string())?;
            let _ = ow.set_value(prog_id, &"");

            let list_path = format!(
                "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.{}\\OpenWithList",
                ext
            );
            if let Ok(list) = reg_open_or_create(&list_path) {
                let _ = list.set_value("q", &prog_id);
                let _ = list.set_value("MRUList", &"q");
            }
        }
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        Err("仅在 Windows 上支持文件关联设置".to_string())
    }
}

/// 添加/移除文件夹右键菜单：在文件夹上或文件夹空白处右键“使用快看看图查看图片”
#[tauri::command]
fn set_folder_context_menu(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let exe = current_exe_string();
        let targets = [
            ("Software\\Classes\\Directory\\shell\\QuickViewBrowse", "%V"),
            (
                "Software\\Classes\\Directory\\Background\\shell\\QuickViewBrowse",
                "%V",
            ),
        ];
        for (base, arg) in targets {
            if enabled {
                let key = reg_open_or_create(base).map_err(|e| e.to_string())?;
                key.set_value("", &"使用快看看图查看图片")
                    .map_err(|e| e.to_string())?;
                key.set_value("Icon", &exe).map_err(|e| e.to_string())?;
                let cmd = reg_open_or_create(&format!("{}\\command", base))
                    .map_err(|e| e.to_string())?;
                cmd.set_value("", &format!("\"{}\" \"{}\"", exe, arg))
                    .map_err(|e| e.to_string())?;
            } else {
                let _ = reg_classes().delete_subkey_all(base);
            }
        }
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("仅在 Windows 上支持右键菜单设置".to_string())
    }
}

#[tauri::command]
fn open_default_apps_settings() -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", "ms-settings:defaultapps"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        return Err("仅在 Windows 上支持".to_string());
    }
    Ok(())
}

/// 应用主题配置路径（%APPDATA%/QuickView/theme.txt）
fn theme_config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("theme.txt"))
}

#[tauri::command]
fn set_window_theme(app: tauri::AppHandle, theme: String) -> Result<(), String> {
    use tauri::Theme;
    let is_light = theme == "light";
    let t = if is_light { Theme::Light } else { Theme::Dark };

    if let Some(win) = app.get_webview_window("main") {
        win.set_theme(Some(t)).map_err(|e| e.to_string())?;
    }
    // 持久化主题，供下次启动时设置标题栏
    if let Some(path) = theme_config_path(&app) {
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(Path::new(".")));
        let _ = std::fs::write(&path, if is_light { "light" } else { "dark" });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("quickview-test-{}-{}", tag, nanos));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn copy_creates_file_with_same_name() {
        let dir = temp_dir("copy1");
        let src = dir.join("a.jpg");
        let dest = dir.join("out");
        fs::create_dir_all(&dest).unwrap();
        fs::write(&src, b"hello").unwrap();

        let result = copy_image_to_folder(
            src.to_string_lossy().into_owned(),
            dest.to_string_lossy().into_owned(),
        )
        .unwrap();

        assert_eq!(PathBuf::from(&result), dest.join("a.jpg"));
        assert_eq!(fs::read(dest.join("a.jpg")).unwrap(), b"hello");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn copy_avoids_duplicate_names() {
        let dir = temp_dir("copy2");
        let src = dir.join("pic.png");
        let dest = dir.join("out");
        fs::create_dir_all(&dest).unwrap();
        fs::write(&src, b"new").unwrap();
        fs::write(dest.join("pic.png"), b"old").unwrap();

        let result = copy_image_to_folder(
            src.to_string_lossy().into_owned(),
            dest.to_string_lossy().into_owned(),
        )
        .unwrap();

        assert_eq!(PathBuf::from(&result), dest.join("pic (1).png"));
        assert_eq!(fs::read(dest.join("pic (1).png")).unwrap(), b"new");
        assert_eq!(fs::read(dest.join("pic.png")).unwrap(), b"old");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn copy_rejects_missing_source() {
        let dir = temp_dir("copy3");
        let result = copy_image_to_folder(
            dir.join("missing.jpg").to_string_lossy().into_owned(),
            dir.to_string_lossy().into_owned(),
        );
        assert!(result.is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn default_folder_prefers_existing_last_folder() {
        let dir = temp_dir("default1");
        let last = dir.to_string_lossy().into_owned();
        let result = get_copy_default_folder(last.clone());
        assert_eq!(result, last);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn default_folder_returns_empty_when_invalid() {
        let dir = temp_dir("default2");
        let missing = dir.join("no-such-dir");
        let result = get_copy_default_folder(missing.to_string_lossy().into_owned());
        assert!(result.is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn default_folder_returns_empty_when_no_history() {
        assert!(get_copy_default_folder(String::new()).is_empty());
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 从命令行参数中找出第一个真实存在的路径（右键菜单 / 文件关联传入）
            let mut target: Option<LaunchTarget> = None;
            for arg in std::env::args_os().skip(1) {
                let s = arg.to_string_lossy().into_owned();
                let p = Path::new(&s);
                if !p.exists() || s.starts_with("--") || s.starts_with("http") {
                    continue;
                }
                target = Some(LaunchTarget {
                    is_dir: p.is_dir(),
                    path: s,
                });
                break;
            }
            app.manage(LaunchState {
                target: Mutex::new(target),
            });

            // 按上次保存的主题设置窗口（标题栏）主题，默认暗色
            use tauri::Theme;
            let saved = theme_config_path(&app.handle())
                .and_then(|p| std::fs::read_to_string(p).ok())
                .unwrap_or_else(|| "dark".to_string());
            let theme = if saved.trim() == "light" {
                Theme::Light
            } else {
                Theme::Dark
            };
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_theme(Some(theme));
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            take_launch_target,
            load_images,
            reveal_in_explorer,
            open_folder,
            write_clipboard,
            copy_image_to_folder,
            get_copy_default_folder,
            get_integration_status,
            register_default_viewer,
            set_folder_context_menu,
            open_default_apps_settings,
            set_window_theme,
        ])
        .run(tauri::generate_context!())
        .expect("应用启动失败");
}
