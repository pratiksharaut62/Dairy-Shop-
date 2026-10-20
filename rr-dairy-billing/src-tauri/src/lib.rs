mod backup;
mod menu;
mod printer;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let app_menu = menu::build(app.handle())?;
            app.set_menu(app_menu)?;
            app.on_menu_event(|app, event| menu::handle_event(app, event.id().as_ref()));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backup::save_backup,
            backup::open_backup,
            backup::allow_backup_folder,
            backup::pick_backup_folder,
            printer::list_serial_ports,
            printer::print_raw,
            printer::print_silent,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
