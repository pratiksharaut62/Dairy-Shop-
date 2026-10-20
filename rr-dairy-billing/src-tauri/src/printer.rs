//! Raw ESC/POS transport. All receipt *formatting* (what bytes to send)
//! happens in TypeScript (src/lib/escpos.ts) so the layout logic lives in
//! one place next to the rest of the billing code — this module is just a
//! thin, reliable pipe from "here are some bytes" to "the printer has them",
//! over either a USB/serial (COM) port or a network socket.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

#[derive(Serialize)]
pub struct SerialPortInfo {
    pub path: String,
    pub label: String,
}

/// Most budget ESC/POS thermal printers sold in India show up over USB as a
/// USB-to-serial adapter (CH340/CP210x/PL2303), so they enumerate here as an
/// ordinary COM/tty port rather than a raw USB printer-class device.
#[tauri::command]
pub fn list_serial_ports() -> Result<Vec<SerialPortInfo>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    Ok(ports
        .into_iter()
        .map(|p| {
            let label = match p.port_type {
                serialport::SerialPortType::UsbPort(info) => {
                    let product = info.product.clone().unwrap_or_else(|| "USB serial device".into());
                    match (info.vid, info.pid) {
                        (vid, pid) => format!("{product} ({vid:04x}:{pid:04x})"),
                    }
                }
                _ => "Serial port".into(),
            };
            SerialPortInfo { path: p.port_name, label }
        })
        .collect())
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PrinterTarget {
    UsbSerial { path: String, baud: u32 },
    Network { host: String, port: u16 },
}

/// Writes raw bytes straight to the printer — no parsing, no retry, no
/// receipt knowledge. A short timeout on both paths so a misconfigured or
/// powered-off printer fails fast with a clear error instead of hanging the
/// counter.
#[tauri::command]
pub fn print_raw(target: PrinterTarget, data: Vec<u8>) -> Result<(), String> {
    match target {
        PrinterTarget::UsbSerial { path, baud } => {
            let mut port = serialport::new(&path, baud)
                .timeout(Duration::from_secs(5))
                .open()
                .map_err(|e| format!("Could not open printer port {path}: {e}"))?;
            port.write_all(&data).map_err(|e| format!("Print failed: {e}"))?;
            port.flush().map_err(|e| format!("Print failed: {e}"))
        }
        PrinterTarget::Network { host, port } => {
            let addr = (host.as_str(), port)
                .to_socket_addrs()
                .map_err(|e| format!("Could not resolve printer address {host}:{port}: {e}"))?
                .next()
                .ok_or_else(|| format!("Could not resolve printer address {host}:{port}"))?;
            let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5))
                .map_err(|e| format!("Could not reach printer at {host}:{port}: {e}"))?;
            stream.write_all(&data).map_err(|e| format!("Print failed: {e}"))?;
            stream.flush().map_err(|e| format!("Print failed: {e}"))
        }
    }
}

/// Prints the page's `#print-root` content through the Windows print system **without showing the print dialog**,
/// to the Windows default printer. Used for receipts only — barcode labels still go through the normal dialog, so
/// a different (label) printer can be picked. (The old `--kiosk-printing` switch silenced every print in the app.)
#[cfg(windows)]
#[tauri::command]
pub async fn print_silent(window: tauri::WebviewWindow) -> Result<(), String> {
    use std::sync::mpsc;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2PrintSettings, ICoreWebView2_16, COREWEBVIEW2_PRINT_STATUS_SUCCEEDED,
    };
    use webview2_com::PrintCompletedHandler;
    use windows::core::Interface;

    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let tx_start = tx.clone();
    window
        .with_webview(move |webview| unsafe {
            let started = (|| -> Result<(), String> {
                let core = webview.controller().CoreWebView2().map_err(|e| e.to_string())?;
                let core16: ICoreWebView2_16 = core.cast().map_err(|e| format!("Silent printing needs a newer WebView2 runtime: {e}"))?;
                let done = tx.clone();
                let handler = PrintCompletedHandler::create(Box::new(move |result, status| {
                    let _ = done.send(match result {
                        Ok(()) if status == COREWEBVIEW2_PRINT_STATUS_SUCCEEDED => Ok(()),
                        Ok(()) => Err("The printer did not accept the job".to_string()),
                        Err(e) => Err(e.to_string()),
                    });
                    Ok(())
                }));
                core16.Print(None::<&ICoreWebView2PrintSettings>, &handler).map_err(|e| e.to_string())
            })();
            if let Err(e) = started {
                let _ = tx_start.send(Err(e));
            }
        })
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(60)).unwrap_or_else(|_| Err("The printer took too long to respond".to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Not available outside Windows — the page falls back to the normal print dialog.
#[cfg(not(windows))]
#[tauri::command]
pub async fn print_silent() -> Result<(), String> {
    Err("Silent printing is only available in the Windows app".into())
}
