# Data safety — how Krishna Collection protects the shop's data

Billing data lives on the counter computer first (so billing works with no internet), and is protected in
layers behind that. Each layer covers a failure the others don't.

| Layer | What it does | Covers |
|---|---|---|
| **1. Live sync** (`src/lib/sync.ts`) | Every sale, stock change and edit is queued and sent to the cloud database (Neon) within about a second, retried every 30 s. A change the server refuses for good is set aside after 3 tries so it cannot block everything behind it. | A dead PC, a stolen PC — you lose seconds, not days. Also feeds new devices and the web app. |
| **2. Full cloud backup** (`src/lib/backup.ts`, `backend/src/modules/backups.controller.ts`) | Every **5 / 15 / 60 min** (owner's choice, default 15) a complete compressed copy of *everything* is uploaded — only if something changed. The server keeps the newest 12, the last one of each day for 30 days, and the last 10 manual ones. | Anything the live sync can't carry: audit log, stock ledger, work done while sync was off, a stuck sync queue. Gives point-in-time versions to restore. |
| **3. Backup files on the PC** (desktop app) | Same schedule, **plus one last save when the window is closed** (capped at 6 s so closing never hangs): a file is written to `Documents\Krishna Collection Backups` and, if chosen, to a **second drive** (USB stick / second disk). Written to a temp file, read back to prove it is complete, then renamed — a power cut can't leave a half-written backup. Keeps the newest 24 files plus one per day for 30 days. Optionally **locked** with a recovery key (below). | No internet for days; cloud account problems; the PC's own disk full or dying. |
| **4. Protected storage** | The app asks the system not to clear its data automatically (`navigator.storage.persist()`). | The OS/web view silently evicting data when disk space is low. |
| **5. Backup file you can carry away** (Settings → Data → Backup file) | One file with all data. Optional **passphrase protection** (AES-256-GCM, PBKDF2-SHA-256, 250 000 rounds). | Keeping a copy off-site (USB, email) without exposing customer data. |

## What the owner sees

* **Settings → Data → Data safety**: a status row per layer (✓ / ! / –), an overall "Protected / Needs attention / At risk"
  badge, the schedule (5 min / 15 min / 1 hour), **Back up now**, and **Sync now**.
* **Cloud backups** list (owner & manager see it; only the owner can **Restore**).
* A **banner across the top of every page** appears when data is not fully protected: not connected to the cloud,
  sign-in expired (sync paused), changes stuck for over 10 minutes, or a backup failing.

## Staff PINs

Each PIN is stored only as a salted PBKDF2-SHA-256 hash (`pbkdf2$…`) — in the local database and in every backup file.
Settings → Staff can set a *new* PIN but can no longer show an existing one. The cloud server hashes PINs itself; the real
digits are sent only at the moment one is set, and are removed from the local upload queue once sent. Older installs are
upgraded automatically at the next start. After 5 wrong PINs at the counter the person is locked out for 30 s, doubling up
to 15 min.

## Locking the backup files on the PC

Settings → Data → **Backup files on this computer → Lock the backup files**. The app makes a recovery key
(`XXXX-XXXX-…`, 160 bits) and shows it once; the owner must tick that it is saved somewhere other than the PC (cancelling
the dialog switches protection back off). Files are then AES-256-GCM encrypted. The key also lives inside the app on this PC
so unattended backups can use it — so the lock protects the *files* (copied to OneDrive or a USB stick, or read by someone
who only gets at Documents), not the app's own storage. To restore a locked file: Settings → Data → Restore from file →
enter the recovery key (any case, with or without dashes). If the key **and** the PC are both lost, those files cannot be
opened — the cloud backups (layer 2) are unaffected.

## Restoring

| Situation | What to do |
|---|---|
| Counter PC replaced / data lost, internet works | Install the app → first screen → sign in with the store email. The whole store is downloaded. For the *very latest full copy* (incl. audit log, stock ledger) then use Settings → Data → Cloud backups → **Restore**. |
| Mistake (wrong bulk edit etc.) | Settings → Data → Cloud backups → pick a version from before the mistake → **Restore** (owner). |
| No internet, data lost | Settings → Data → Backup file → **Restore from file** and choose a file from `Documents\Krishna Collection Backups` (or a protected file you saved). |

Restoring replaces everything on the device (a confirmation shows what the backup contains). Staff keep their current
PINs — **cloud backups contain no PINs at all**; backup files on the PC contain only the scrambled hashes.

## Deploying the backend part

```bash
cd backend
npm run migrate:prod        # applies migrations/002_backups.sql (creates the `backups` table)
```
* `CORS_ORIGINS` must include the hosted web app origin, as before. The desktop app is always allowed.
* Backups are sent as raw gzip (limit 45 MB request / 40 MB stored). **On Vercel the platform caps request/response bodies
  at 4.5 MB**, which is lower — see [DEPLOY.md](DEPLOY.md). A year of busy shop data is a few MB compressed.
* Neon storage use is bounded by the retention rules above (≈ 12 + 30 + 10 versions at most).
* `POST /auth/refresh` is new: counters left open all day renew their cloud token instead of silently stopping after 12 h.

## Verify on the desktop installer (could not be built on the development machine)

The desktop-only parts type-check against the real Tauri plugin APIs but were **not run inside Tauri**. After the
next CI build (`desktop-release` workflow), on a Windows machine:

1. Install and sign in. Open **Settings → Data**. "Backup on this computer" should show a ✓ and a file name within ~30 s
   (not an error).
2. Check `Documents\Krishna Collection Backups\` contains `auto-…json` and `daily-…json`.
3. If step 1 shows a permission error, the capability in `src-tauri/capabilities/default.json`
   (`fs:scope`: the Documents folder, and a `Krishna Collection Backups` folder at the top of drives `D:`–`Z:`) needs
   adjusting — that file is the only thing to change.
4. Turn on **Lock the backup files**, make a backup, and open the file in Notepad: it must show
   `krishna-collection-encrypted-backup` and no customer names. Then Restore from file using the recovery key.
5. Plug in a USB stick, pick its letter under **Second copy on another drive**, press **Back up now**: the folder appears
   on the stick. Unplug it and press again: a warning appears while Documents still saves.
6. Close the window with the ✕ and with **File → Quit** (each should take under ~6 s): the backup folder gets a fresh file
   if anything changed since the last one. Quit was rewired in `src-tauri/src/menu.rs` to go through the window so this
   runs; that Rust change has **not been compiled** on the development machine — the CI build will show any error.
7. Do **not** change `identifier` in `tauri.conf.json` after installs exist: it decides where the app's local database
   lives, and changing it would make existing installs look empty.

## Known limits (read these)

* **A 4-digit PIN cannot be made truly secret.** Hashing stops PINs being read out of the database or a backup file, but
  anyone who copies the whole database can still try all 10,000 PINs offline. Real protection for the data is a Windows
  password on the counter PC plus BitLocker; the PIN tells staff apart and stops casual use.
* **The recovery key for locked backup files is kept inside the app on the PC** (so backups can run unattended). It protects
  files that leave the app's own storage, not someone with full access to the logged-in Windows account. Locking is optional
  and off by default; older files stay as they were when it is turned on.
* **A change the cloud refuses is set aside, not uploaded.** The banner says so and "Retry" re-queues it. The sale or edit
  is still on the PC and inside every full backup; only the row-by-row copy in the cloud tables lacks it until fixed.
* A server outage (HTTP 5xx) still pauses the queue in order rather than skipping; only permanent refusals
  (400/403/404/405/410/413/422) are set aside.
* The save-on-close backup relies on the window-close event. A power cut, crash or *End task* skips it — the timed backups
  and live sync are what cover those.
* Second-copy drives are limited to letters `D:`–`Z:`, in a folder named `Krishna Collection Backups` at the top of the drive.
* **The desktop-only parts have not been run inside Tauri** (see the checklist above): file writes, drive scope, the
  close hook and Quit. They type-check against the real plugin APIs.

## How we (the developers) see failed syncs and backups

We cannot reach the shop's PC, so problems are found two ways — one that needs nothing from the device, one that
explains why:

1. **Server-side, no cooperation needed.** The cloud knows when each store last uploaded a backup and last synced a
   bill. A store with sales but no backup, or sales newer than a backup more than a day old, is flagged — even if the
   app is uninstalled or the PC is off. (`GET /api/admin/overview`.)
2. **Device reports.** Every 10 minutes (and within 30 s of a problem starting or clearing) each device sends counters
   and reasons: changes waiting, changes refused and why, cloud/PC backup errors, app version. Never bill contents.
   (`POST /api/device-health`, stored in `device_health`.)

Both are shown on **Settings → Diagnostics**, which exists only for a **super admin**: a user with
`users.is_super_admin = true`. That flag is set only from the command line — there is no screen or API that grants it:

```bash
cd backend
DATABASE_URL="<neon url>" npm run super-admin -- --email you@example.com        # grant
DATABASE_URL="<neon url>" npm run super-admin -- --email you@example.com --off  # revoke
```

Shop owners and staff never see Diagnostics or the "changes were refused by the cloud" banner — they cannot act on it and
it never affects billing. They still see the actionable warnings (not connected, signed out, backup failing).

Limits: this is a dashboard, not an alarm — nothing emails or messages anyone yet; someone has to open Diagnostics. A
device on an old app version, or one that has never been able to reach the server, reports nothing, which is why the
server-side check (1) exists.
