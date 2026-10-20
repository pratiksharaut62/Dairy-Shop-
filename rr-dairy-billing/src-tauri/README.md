# Krishna Collection — Desktop App (Tauri)

The same React app from the repo root, running as a real native window
instead of a browser tab — via [Tauri](https://tauri.app) rather than
Electron, so it's a small Rust shell around the OS's own webview instead of
a bundled Chromium. Same local IndexedDB storage, same offline-first
behaviour; this folder only adds native chrome (a File menu, backup
dialogs) and a real hardware printer path.

**Installer size:** ~3.6MB (verified — `.deb`/`.rpm`/`.AppImage` all built
and launched successfully). An Electron equivalent would be 100MB+.

---

## Prerequisites

1. **Rust** — install via [rustup.rs](https://rustup.rs). Any recent
   stable toolchain works; this was built against 1.94.
2. **Platform webview dependencies:**

   **Linux** (Debian/Ubuntu):
   ```bash
   sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
     librsvg2-dev libssl-dev build-essential libgtk-3-dev libsoup-3.0-dev \
     libjavascriptcoregtk-4.1-dev pkg-config
   ```

   **Windows** — Visual Studio Build Tools (the "Desktop development with
   C++" workload) and the WebView2 runtime (already installed on any
   current Windows 10/11).

   **macOS** — Xcode Command Line Tools (`xcode-select --install`). WKWebView
   ships with the OS.

   Full details: [tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/).

## Running it

From the **repo root** (not this folder):

```bash
npm install
npm run tauri:dev       # hot-reloading dev window (Vite + Rust, both watched)
npm run tauri:build     # real installer(s) for whatever OS you run this on
```

`tauri:build` output lands in
`src-tauri/target/release/bundle/<format>/` — `deb`/`rpm`/`appimage` on
Linux, `msi`/`nsis` on Windows, `dmg`/`app` on macOS. It only cross-builds
for the OS you're actually running it on; an `.exe` needs a Windows
machine or CI runner, a `.dmg` needs macOS.

A plain `cargo build` (bypassing the `npm run tauri:*` scripts) also
compiles, but **only for a syntax/type check** — it doesn't switch the app
over to loading the embedded frontend, so the resulting binary just tries
to reach `http://localhost:5173` and shows a blank "connection refused"
page unless `npm run dev` happens to be running alongside it. Always use
`npm run tauri:dev` / `npm run tauri:build` (or `npx tauri dev` /
`npx tauri build`) to get a binary that actually works standalone.

**Icons.** `icons/` currently holds Tauri's default placeholder icon.
Replace it with your own before shipping installers to anyone outside the
team — `npx tauri icon path/to/logo.png` regenerates every size Tauri
needs from one source image.

---

## What's in this folder

| File | Purpose |
|---|---|
| `tauri.conf.json` | Window size, app identifier, bundle targets, dev/build commands |
| `capabilities/default.json` | The permission allow-list — every plugin command (dialog, filesystem) the frontend is allowed to call. Custom commands (below) aren't gated by this; only plugin-provided ones are. |
| `src/lib.rs` | App entry point — registers plugins, builds the native menu, wires menu clicks to events |
| `src/menu.rs` | The File/Edit/View/Window/Help menu itself |
| `src/backup.rs` | `save_backup` / `open_backup` commands — native save/open dialogs for the JSON backup Settings → Data already builds |
| `src/printer.rs` | `list_serial_ports` / `print_raw` commands — see below |

The Rust side is deliberately thin. `printer.rs` in particular has *no
idea what a receipt looks like* — it just writes whatever bytes it's
handed to a serial port or a TCP socket. The actual receipt formatting
(what bytes to send) lives in TypeScript at `../src/lib/escpos.ts`, next
to the rest of the billing logic it mirrors (`../src/print/Receipt.tsx`).
That split keeps the "what does a bill say" business logic in one
language and the "how do bytes reach a physical device" plumbing in
another, and means printer support doesn't require touching Rust again
unless you're adding a new *kind* of connection.

---

## Native menu & shortcuts

| Menu item | Shortcut | What it does |
|---|---|---|
| File → New Bill | Ctrl/Cmd+N | Navigate to Billing (POS) |
| File → Dashboard | Ctrl/Cmd+H | Navigate to the Dashboard |
| File → Backup Data… | — | Opens a native save dialog, writes the JSON backup |
| Edit → Undo/Redo/Cut/Copy/Paste/Select All | standard | Native OS text-editing shortcuts |
| Help → About Krishna Collection | — | Version info dialog |

These are separate from, and don't replace, the app's own in-page
keyboard shortcuts (`F1` billing, `F2` scan box, `F3` customer, `F4`
payment, `F9` dashboard, `Esc` close) — those are plain React `keydown`
handlers in `../src/App.tsx` and work identically in the browser, this
desktop shell, or any other wrapper, since they don't depend on anything
native.

---

## Setting up a real receipt printer

By default (**Settings → Receipt & loyalty → Hardware printer → Browser
dialog**) receipts print through the OS print dialog, exactly like the
plain web app — works with any printer that's already set up in Windows/
macOS/Linux, no extra configuration. Switching to **USB** or **Network**
sends raw ESC/POS bytes straight to the printer instead: no print dialog,
no "select printer" step at the counter, and a cash sale automatically
kicks the cash drawer open.

### USB

Almost all budget ESC/POS thermal printers sold in India (and most
"generic" ESC/POS printers generally) connect over USB but identify
themselves as a **USB-to-serial adapter** (chipsets like CH340, CP2102,
PL2303) rather than a native USB printer — which is why they show up as
an ordinary serial/COM port, not as a printer in your OS's printer list.

1. Plug the printer into USB and power it on.
2. **Settings → Receipt & loyalty → Hardware printer → USB.**
3. Click **Refresh** — the port should appear in the dropdown (something
   like `COM3` on Windows, `/dev/ttyUSB0` on Linux, `/dev/tty.usbserial-XXXX`
   on macOS). If it doesn't show up, the printer's USB driver likely isn't
   installed — check the printer manual for a CH340/CP2102 driver link.
4. **Baud rate** — `9600` is the default and correct for most printers.
   If a test print comes out as garbled characters instead of readable
   text, the baud rate is the first thing to check against your printer's
   manual (`19200` and `38400` are the next most common).
5. Click **Test print**. If it fails, the error message names the exact
   problem (wrong/busy port, printer off, etc.) rather than failing silently.
6. **Save changes** once a test print works.

### Network

Any printer with its own IP address (most mid-range and higher ESC/POS
printers, e.g. the Epson TM-T88 series, support this over Wi-Fi or
Ethernet).

1. Find the printer's IP address — either from its own configuration
   printout/menu, or your router's connected-devices list.
2. **Settings → Receipt & loyalty → Hardware printer → Network.**
3. Enter the IP address. **Port 9100** is the standard raw/JetDirect
   printing port nearly every network thermal printer listens on by
   default — leave it unless your printer's manual says otherwise.
4. **Test print**, then **Save changes**.

### Cash drawer

A cash drawer normally connects to the *printer* (via an RJ11 cable, not
directly to the computer) and is triggered by a command sent through the
printer, not a separate device the app talks to. Once a USB or Network
printer is configured:

- A **cash** sale automatically sends the drawer-kick pulse after the receipt.
- The **Open cash drawer** button in Settings does a manual kick with no
  receipt printed — useful for a no-sale open (making change, start-of-day
  float, etc.).

If the drawer doesn't open: confirm it's actually wired to the printer
(not the PC) and that the printer itself is one of the connection types
above — a drawer can't be triggered through the plain browser-print path,
since that goes through the OS print spooler rather than talking to the
printer directly.

### What this can't verify for you

None of the above can be tested from a development sandbox without a
physical printer attached — the Rust transport code (`print_raw` in
`src/printer.rs`) and its error handling are correct and exercised, but
only up to "bytes were handed to this serial port / socket successfully."
Whether your specific printer parses those ESC/POS bytes correctly is
something only a real test print on real hardware can confirm. If a test
print produces the wrong paper width, wrong font, or a barcode that
doesn't scan, that's printer-model-specific ESC/POS quirks to tune in
`../src/lib/escpos.ts`, not a sign the pipeline itself is broken.

---

## Troubleshooting

**`error: failed to run custom build command for 'app'` / missing
`webkit2gtk` or similar** — a platform dependency from the Prerequisites
section above is missing. The error names the missing `.pc` file/package;
install it and retry.

**Window opens blank / "Could not connect to localhost"** — you built
with plain `cargo build` instead of `npm run tauri:dev` /
`npm run tauri:build`. See the note under *Running it* above.

**`Refresh` finds no serial ports** — either nothing is plugged in, or the
USB-to-serial driver for your printer's chipset isn't installed on this
OS. Unplug/replug after installing the driver.

**Test print sends but nothing comes out of the printer** — check the
printer has paper, is powered on, and (for USB) that another program
(a print spooler, another app) isn't already holding the port open —
only one process can use a serial port at a time.
