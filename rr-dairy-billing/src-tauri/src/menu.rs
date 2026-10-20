//! Native File/Edit/View/Window/Help menu, mirroring what the Electron
//! shell had. File items emit events the frontend already listens for
//! (menu:navigate, menu:backup) so App.tsx doesn't need to know which
//! desktop shell it's running under.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let new_bill = MenuItem::with_id(app, "new_bill", "New Bill", true, Some("CmdOrCtrl+N"))?;
    let dashboard = MenuItem::with_id(app, "dashboard", "Dashboard", true, Some("CmdOrCtrl+H"))?;
    let backup = MenuItem::with_id(app, "backup", "Backup Data…", true, None::<&str>)?;
    // Not the predefined Quit: that exits the process directly and would skip the save-on-close backup.
    let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("CmdOrCtrl+Q"))?;
    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_bill,
            &dashboard,
            &PredefinedMenuItem::separator(app)?,
            &backup,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
            &quit,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;

    let about = MenuItem::with_id(app, "about", "About Krishna Collection", true, None::<&str>)?;
    let help_menu = Submenu::with_items(app, "Help", true, &[&about])?;

    Menu::with_items(app, &[&file_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
}

pub fn handle_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "new_bill" => { let _ = app.emit("menu:navigate", "/pos"); }
        "dashboard" => { let _ = app.emit("menu:navigate", "/"); }
        "backup" => { let _ = app.emit("menu:backup", ()); }
        "quit" => {
            // Closing the window runs the frontend's save-on-close hook; with no window left, just exit.
            match app.get_webview_window("main") {
                Some(window) => { let _ = window.close(); }
                None => app.exit(0),
            }
        }
        "about" => {
            if let Some(window) = app.get_webview_window("main") {
                let version = app.package_info().version.to_string();
                let _ = tauri_plugin_dialog::DialogExt::dialog(app)
                    .message(format!(
                        "Krishna Collection — Billing\nVersion {version}\nBilling, inventory, barcode and reporting for a single clothing store."
                    ))
                    .title("About Krishna Collection")
                    .parent(&window)
                    .blocking_show();
            }
        }
        _ => {}
    }
}
