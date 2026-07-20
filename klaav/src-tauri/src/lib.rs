// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, Emitter, State};
use tokio::sync::{mpsc, Mutex};
use futures_util::{StreamExt, SinkExt};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;

const SHARED_SECRET_RAW: &str = include_str!("../../../.secret");

/* 
 * WebSocket Message Protocol
 *
 * Client (Extension) -> Server (Tauri)
 * 1. Hello Message (First message sent by client to authenticate)
 *    {"type":"hello", "browser":"chrome", "token":"my-secret-token", "tabs": [{"tab_id": 1, "window_id": 2, "title": "...", "url": "...", "active": true}]}
 *
 * 2. Tabs Update Message (Sent by client whenever its tabs change)
 *    {"type":"tabs-update", "tabs": [{"tab_id": 1, ...}]}
 *
 * Server (Tauri) -> Client (Extension)
 * 1. Activate Tab
 *    {"type":"activate-tab", "tab_id": 1, "window_id": 2}
 *
 * 2. Close Tab
 *    {"type":"close-tab", "tab_id": 1, "window_id": 2}
 */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tab {
    pub tab_id: u32,
    pub window_id: u32,
    pub title: String,
    pub url: String,
    pub active: bool,
    #[serde(default)]
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TabWithBrowser {
    pub browser: String,
    #[serde(flatten)]
    pub tab: Tab,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum ClientMessage {
    #[serde(rename = "hello")]
    Hello {
        browser: String,
        token: String,
        tabs: Vec<Tab>,
    },
    #[serde(rename = "tabs-update")]
    TabsUpdate {
        tabs: Vec<Tab>,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
    #[serde(rename = "activate-tab")]
    ActivateTab { tab_id: u32, window_id: u32 },
    #[serde(rename = "close-tab")]
    CloseTab { tab_id: u32, window_id: u32 },
}

pub struct BrowserState {
    pub tx: mpsc::Sender<String>,
    pub tabs: Vec<Tab>,
}

pub type AppState = Arc<Mutex<HashMap<String, BrowserState>>>;

pub struct HotkeyState {
    pub is_pinned: std::sync::atomic::AtomicBool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub group_by_browser: bool,
    pub theme: String,
    #[serde(default)]
    pub pinned_urls: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            group_by_browser: false,
            theme: "glass".to_string(),
            pinned_urls: Vec::new(),
        }
    }
}

pub struct UIState {
    pub settings_open: std::sync::atomic::AtomicBool,
    pub selected_index: std::sync::atomic::AtomicIsize,
}

#[tauri::command]
fn report_settings_open(state: tauri::State<UIState>, is_open: bool) {
    state.settings_open.store(is_open, std::sync::atomic::Ordering::Relaxed);
}

#[tauri::command]
fn sync_selection(state: tauri::State<UIState>, index: isize) {
    state.selected_index.store(index, std::sync::atomic::Ordering::Relaxed);
}

fn get_settings_path(app_handle: &tauri::AppHandle) -> Option<PathBuf> {
    app_handle.path().app_data_dir().ok().map(|dir| dir.join("settings.json"))
}

#[tauri::command]
fn load_settings(app_handle: tauri::AppHandle) -> Settings {
    if let Some(path) = get_settings_path(&app_handle) {
        if path.exists() {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(settings) = serde_json::from_str(&content) {
                    return settings;
                }
            }
        }
    }
    Settings::default()
}

#[tauri::command]
fn save_settings(app_handle: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    if let Some(path) = get_settings_path(&app_handle) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let content = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
        fs::write(path, content).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn switch_tab(
    browser: String, 
    tab_id: u32, 
    window_id: u32, 
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    hotkey_state: State<'_, HotkeyState>
) -> Result<(), String> {
    let state_lock = state.lock().await;
    if let Some(browser_state) = state_lock.get(&browser) {
        let msg = serde_json::to_string(&ServerMessage::ActivateTab { tab_id, window_id })
            .map_err(|e| e.to_string())?;
            
        // Explicitly allow any process (i.e. the browser) to steal foreground focus from us.
        // Without this, Windows prevents background processes from jumping to the front,
        // causing the browser's taskbar icon to flash instead of actually opening.
        #[cfg(windows)]
        {
            use windows::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};
            unsafe {
                let _ = AllowSetForegroundWindow(ASFW_ANY);
            }
        }

        let _ = browser_state.tx.send(msg).await;
        
        // Hide and unpin the window after a tab is selected
        hotkey_state.is_pinned.store(false, std::sync::atomic::Ordering::Relaxed);
        let _ = window.hide();
        
        Ok(())
    } else {
        Err("Browser not found".into())
    }
}

#[tauri::command]
async fn close_tab(browser: String, tab_id: u32, window_id: u32, state: State<'_, AppState>) -> Result<(), String> {
    let state_lock = state.lock().await;
    if let Some(browser_state) = state_lock.get(&browser) {
        let msg = serde_json::to_string(&ServerMessage::CloseTab { tab_id, window_id })
            .map_err(|e| e.to_string())?;
        let _ = browser_state.tx.send(msg).await;
        Ok(())
    } else {
        Err("Browser not found".into())
    }
}

async fn broadcast_tabs(app_handle: &tauri::AppHandle, state: &AppState) {
    let mut all_tabs = Vec::new();
    {
        let state_lock = state.lock().await;
        println!("--- Current Aggregated Tabs ---");
        for (browser, browser_state) in state_lock.iter() {
            println!("Browser: {}", browser);
            for tab in &browser_state.tabs {
                println!("  - {}", tab.title);
                all_tabs.push(TabWithBrowser {
                    browser: browser.clone(),
                    tab: tab.clone(),
                });
            }
        }
        println!("-------------------------------");
    }
    let _ = app_handle.emit("tabs-updated", all_tabs);
}

fn spawn_websocket_server(app_handle: tauri::AppHandle, state: AppState) {
    tauri::async_runtime::spawn(async move {
        let addr = "127.0.0.1:8765";
        let listener = match TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("Failed to bind WebSocket server: {}", e);
                return;
            }
        };
        println!("WebSocket server listening on ws://{}", addr);

        while let Ok((stream, _)) = listener.accept().await {
            let app_handle = app_handle.clone();
            let state = state.clone();
            tauri::async_runtime::spawn(async move {
                let ws_stream = match tokio_tungstenite::accept_async(stream).await {
                    Ok(ws) => ws,
                    Err(e) => {
                        eprintln!("Error during WebSocket handshake: {}", e);
                        return;
                    }
                };
                
                let (mut write, mut read) = ws_stream.split();
                let mut browser_id: Option<String> = None;
                
                // Read the hello message
                if let Some(Ok(msg)) = read.next().await {
                    if let Ok(text) = msg.to_text() {
                        if let Ok(ClientMessage::Hello { browser, token, tabs }) = serde_json::from_str(text) {
                            if token != SHARED_SECRET_RAW.trim() {
                                eprintln!("Invalid token from browser: {}", browser);
                                return;
                            }
                            
                            println!("New connection from browser: {}", browser);
                            
                            browser_id = Some(browser.clone());
                            let (tx, mut rx) = mpsc::channel::<String>(32);
                            
                            {
                                let mut state_lock = state.lock().await;
                                state_lock.insert(browser.clone(), BrowserState { tx, tabs });
                            }
                            
                            broadcast_tabs(&app_handle, &state).await;
                            
                            // Spawn a task to send messages from tx channel to the websocket
                            tauri::async_runtime::spawn(async move {
                                while let Some(msg) = rx.recv().await {
                                    if write.send(tokio_tungstenite::tungstenite::Message::Text(msg.into())).await.is_err() {
                                        break;
                                    }
                                }
                            });
                        } else {
                            eprintln!("Expected Hello message");
                            return;
                        }
                    }
                }
                
                if let Some(browser) = browser_id {
                    // Handle incoming messages
                    while let Some(Ok(msg)) = read.next().await {
                        if let Ok(text) = msg.to_text() {
                            if let Ok(ClientMessage::TabsUpdate { tabs }) = serde_json::from_str(text) {
                                {
                                    let mut state_lock = state.lock().await;
                                    if let Some(browser_state) = state_lock.get_mut(&browser) {
                                        browser_state.tabs = tabs;
                                    }
                                }
                                broadcast_tabs(&app_handle, &state).await;
                            }
                        }
                    }
                    
                    // Connection closed, remove browser state
                    {
                        let mut state_lock = state.lock().await;
                        state_lock.remove(&browser);
                    }
                    broadcast_tabs(&app_handle, &state).await;
                }
            });
        }
    });
}

/// Polls the OS cursor position every 50ms and shows/hides the window
/// based on whether the cursor is in the left-edge trigger zone or
/// within the panel's own bounds.
fn spawn_cursor_watcher(app_handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        use std::sync::atomic::{AtomicBool, Ordering};
        let is_visible = Arc::new(AtomicBool::new(false));

        loop {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;

            // Check if the window is currently pinned by a hotkey
            let is_pinned = app_handle.try_state::<HotkeyState>()
                .map(|s| s.is_pinned.load(Ordering::Relaxed))
                .unwrap_or(false);

            let window = match app_handle.get_webview_window("main") {
                Some(w) => w,
                None => continue,
            };

            // If pinned by the hotkey, we ensure our internal `is_visible` flag is synced
            // and skip the auto-hide logic based on cursor completely.
            if is_pinned {
                is_visible.store(true, Ordering::Relaxed);
                continue;
            }

            let monitor = match window.primary_monitor() {
                Ok(Some(m)) => m,
                _ => continue,
            };

            // Get the cursor position via Win32 GetCursorPos
            let cursor_pos = {
                #[cfg(windows)]
                {
                    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
                    use windows::Win32::Foundation::POINT;
                    let mut pt = POINT { x: 0, y: 0 };
                    let ok = unsafe { GetCursorPos(&mut pt) };
                    if ok.is_ok() {
                        Some((pt.x, pt.y))
                    } else {
                        None
                    }
                }
                #[cfg(not(windows))]
                {
                    None::<(i32, i32)>
                }
            };

            let (cx, cy) = match cursor_pos {
                Some(p) => p,
                None => continue,
            };

            let scale = monitor.scale_factor();
            let panel_phys_w = (234.0 * scale) as i32;
            let panel_phys_h = (monitor.size().height as f64 * 0.6) as i32;
            
            let panel_x = monitor.position().x;
            let panel_y = monitor.position().y + ((monitor.size().height as i32 - panel_phys_h) / 2);

            let trigger_margin = (10.0 * scale) as i32;
            let in_trigger_zone = cx >= panel_x
                && cx <= panel_x + trigger_margin
                && cy >= panel_y
                && cy <= panel_y + panel_phys_h;

            let is_settings_open = app_handle.try_state::<UIState>()
                .map(|s| s.settings_open.load(Ordering::Relaxed))
                .unwrap_or(false);

            // Hysteresis bound: adding a buffer to the hide bounds
            let mut buffer_x = (120.0 * scale) as i32;
            let mut buffer_y = (120.0 * scale) as i32;
            
            if is_settings_open {
                buffer_x += (250.0 * scale) as i32;
                buffer_y += (200.0 * scale) as i32;
            }

            let in_hysteresis_bounds = cx >= panel_x - buffer_x
                && cx <= panel_x + panel_phys_w + buffer_x
                && cy >= panel_y - buffer_y
                && cy <= panel_y + panel_phys_h + buffer_y;

            let currently_visible = is_visible.load(Ordering::Relaxed);

            if !currently_visible && in_trigger_zone {
                let _ = window.set_position(tauri::PhysicalPosition::new(panel_x - panel_phys_w, panel_y));
                let _ = window.show();
                let _ = window.set_focus();
                is_visible.store(true, Ordering::Relaxed);
                
                let w = window.clone();
                tauri::async_runtime::spawn(async move {
                    let steps = 15;
                    for i in 1..=steps {
                        let t = i as f64 / steps as f64;
                        let ease = 1.0 - (1.0 - t).powi(3); // cubic ease out
                        let new_x = (panel_x - panel_phys_w) as f64 + (panel_phys_w as f64 * ease);
                        let _ = w.set_position(tauri::PhysicalPosition::new(new_x as i32, panel_y));
                        tokio::time::sleep(std::time::Duration::from_millis(15)).await;
                    }
                    let _ = w.set_position(tauri::PhysicalPosition::new(panel_x, panel_y));
                });
            } else if currently_visible && !in_trigger_zone && !in_hysteresis_bounds {
                // Cursor left both the trigger zone and the hysteresis buffer — hide
                let _ = window.hide();
                is_visible.store(false, Ordering::Relaxed);
            }
        }
    });
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    use tauri::Manager;
                    use tauri_plugin_global_shortcut::ShortcutState;
                    if event.state == ShortcutState::Pressed {
                        use std::str::FromStr;
                        let alt_q = tauri_plugin_global_shortcut::Shortcut::from_str("Alt+Q").unwrap();
                        
                        // Handle Alt+Q (Toggle Panel)
                        if _shortcut.id() == alt_q.id() {
                            if let Some(state) = app.try_state::<HotkeyState>() {
                                let currently_pinned = state.is_pinned.load(std::sync::atomic::Ordering::Relaxed);
                                if currently_pinned {
                                    state.is_pinned.store(false, std::sync::atomic::Ordering::Relaxed);
                                    if let Some(window) = app.get_webview_window("main") {
                                        let _ = window.hide();
                                    }
                                } else {
                                    state.is_pinned.store(true, std::sync::atomic::Ordering::Relaxed);
                                    if let Some(window) = app.get_webview_window("main") {
                                        if let Ok(Some(monitor)) = window.primary_monitor() {
                                            let scale = monitor.scale_factor();
                                            let panel_phys_w = (234.0 * scale) as i32;
                                            let panel_phys_h = (monitor.size().height as f64 * 0.6) as i32;
                                            let panel_x = monitor.position().x;
                                            let panel_y = monitor.position().y + ((monitor.size().height as i32 - panel_phys_h) / 2);

                                            let _ = window.set_position(tauri::PhysicalPosition::new(panel_x - panel_phys_w, panel_y));
                                            let _ = window.show();
                                            let _ = window.set_focus();

                                            let w = window.clone();
                                            tauri::async_runtime::spawn(async move {
                                                let steps = 15;
                                                for i in 1..=steps {
                                                    let t = i as f64 / steps as f64;
                                                    let ease = 1.0 - (1.0 - t).powi(3); // cubic ease out
                                                    let new_x = (panel_x - panel_phys_w) as f64 + (panel_phys_w as f64 * ease);
                                                    let _ = w.set_position(tauri::PhysicalPosition::new(new_x as i32, panel_y));
                                                    tokio::time::sleep(std::time::Duration::from_millis(15)).await;
                                                }
                                                let _ = w.set_position(tauri::PhysicalPosition::new(panel_x, panel_y));
                                            });
                                        }
                                    }
                                }
                            }
                        } 
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![report_settings_open, sync_selection, load_settings, save_settings, switch_tab, close_tab])
        .setup(|app| {
            let app_state: AppState = Arc::new(Mutex::new(HashMap::new()));
            app.manage(app_state.clone());
            
            // Manage the hotkey state for toggling
            app.manage(HotkeyState {
                is_pinned: std::sync::atomic::AtomicBool::new(false),
            });

            app.manage(UIState {
                settings_open: std::sync::atomic::AtomicBool::new(false),
                selected_index: std::sync::atomic::AtomicIsize::new(-1),
            });

            spawn_websocket_server(app.handle().clone(), app_state);

            use tauri::{menu::{Menu, MenuItem}, tray::TrayIconBuilder};
            use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
            
            let parse_and_register = |app: &tauri::App, name: &str| {
                match name.parse::<Shortcut>() {
                    Ok(shortcut) => {
                        match app.global_shortcut().register(shortcut) {
                            Ok(_) => println!("✅ Successfully registered shortcut: {}", name),
                            Err(e) => println!("❌ Failed to register shortcut {}: {:?}", name, e),
                        }
                    }
                    Err(e) => println!("❌ Failed to parse shortcut string {}: {:?}", name, e),
                }
            };

            parse_and_register(app, "Alt+Q");

            let show_i = MenuItem::with_id(app, "show", "Show Klaav", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(state) = app.try_state::<HotkeyState>() {
                            state.is_pinned.store(true, std::sync::atomic::Ordering::Relaxed);
                        }
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        std::process::exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                println!("Main window found!");
                println!("is_decorated: {:?}", window.is_decorated());
                println!("outer_size: {:?}", window.outer_size());
                println!("outer_position: {:?}", window.outer_position());

                if let Ok(Some(monitor)) = window.primary_monitor() {
                    let scale_factor = monitor.scale_factor();
                    let physical_width = (234.0 * scale_factor) as u32;
                    let physical_height = (monitor.size().height as f64 * 0.6) as u32;
                    
                    let y = monitor.position().y + ((monitor.size().height - physical_height) as i32 / 2);
                    let x = monitor.position().x;
                    
                    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: physical_width, height: physical_height }));
                    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
                    // Start HIDDEN — the cursor watcher will show it when needed
                    let _ = window.hide();
                }

                let app_handle = app.handle().clone();
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(focused) = event {
                        if !focused {
                            if let Some(state) = app_handle.try_state::<HotkeyState>() {
                                state.is_pinned.store(false, std::sync::atomic::Ordering::Relaxed);
                            }
                            let _ = window_clone.hide();
                        }
                    }
                });
            } else {
                println!("Main window NOT found!");
            }

            // Spawn the cursor-based show/hide watcher
            spawn_cursor_watcher(app.handle().clone());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
