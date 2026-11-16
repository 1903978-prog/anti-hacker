# SecVal second copy (Dropbox): key custody and restore

Off unless `SECVAL_SECOND_COPY=on`. Daily, into `/backups nov26/secval/DB` and `/backups nov26/secval/CODE`, 14 days kept.

## The key
- `SECVAL_BACKUP_KEY` (at least 32 characters) is the only key. It is NOT derived from the Backblaze (Litestream) secret, so losing or leaking one never exposes the other.
- Set it once as a Render secret. Livio keeps a copy in his password manager: without it the Dropbox copies cannot be read, and nobody else holds it.
- No key set = no copy is made (never uploaded unencrypted).

## What is in each copy
- `NNNNNN-secval-db.dump.enc`: the SQLite store (`VACUUM INTO`), gzip, AES-256-GCM.
- `NNNNNN-secval-code.zip.enc`: SOURCE ONLY. An allowlist of release files (root config files and `server/`, `public/`, `scripts/`, `test/` with listed extensions). Hidden files, `.env*`, keys, certificates, credentials, databases, dumps, logs and symlinks are refused. 2 MiB per file, 32 MiB and 2000 files total. Rebuild needs `npm ci` and the server secrets.
- `NNNNNN-secval-<kind>.manifest.json`: backup id, SHA-256, size, source commit, key id, file list. The Dropbox check counts a copy only when its manifest exists.

## Restore (isolated, never onto production)
1. Download the `.enc` file and its manifest from Dropbox; check the file's SHA-256 against the manifest.
2. Decrypt with the key (same code as the app): `decrypt()` in `server/backup/secondCopy.ts` with `backupKey({ SECVAL_BACKUP_KEY })`.
3. Database: gunzip, write to a new file, open it read-only, run `PRAGMA integrity_check` (expect `ok`).
4. Code: `readZip()` checks every entry's CRC and refuses unsafe names; extract to an empty folder, `npm ci`, `npx tsc --noEmit`.
The test `isolated restore` in `test/backup-second-copy.test.ts` runs steps 2-4 on every check.
