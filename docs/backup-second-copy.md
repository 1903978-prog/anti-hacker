# SecVal second copy (Dropbox): key custody and restore

Off unless `SECVAL_SECOND_COPY=on` (or `dryrun`, which writes nothing; see "Activation"). Daily, into `/backups nov26/secval/DB` and `/backups nov26/secval/CODE`, 14 days kept.

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

## Not a second provider
Daily files in one Dropbox account are extra recovery points in ONE provider. The independent copy of the
database stays Litestream to Backblaze; this Dropbox copy is the second one. The code's two homes are GitHub
and this Dropbox archive. Each copy counts only after its own restore has been checked.

## Minimum permissions
- Dropbox app scopes: `files.metadata.read` (list for retention), `files.content.read` (download check),
  `files.content.write` (upload; delete only its own dated files). Nothing else (no sharing, no account or team scopes).
- Render: four secrets on the SecVal service only: `SECVAL_BACKUP_KEY` (new, independent),
  `DROPBOX_REFRESH_TOKEN`, `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET` (already set for the read-only check),
  plus `SECVAL_SECOND_COPY`. No route exposes them; nothing new is public.

## Activation (staged; nothing here waives a release safeguard)
0. Before any release: the existing Backblaze copy and its restore drill are the backup safeguard. The new
   code is not asked to back itself up before it exists.
1. Release approval for the exact SHA, with `SECVAL_SECOND_COPY` unset. The code ships dormant. Rollback =
   previous Render deploy.
2. Config approval: set `SECVAL_BACKUP_KEY` (a copy also in Livio's password manager) and
   `SECVAL_SECOND_COPY=dryrun`. The dry run builds, encrypts, decrypts and checks both copies on the server,
   signs in to Dropbox, reports the token's scopes and whether `/backups nov26` can be read, and uploads or
   deletes NOTHING. Its result is in the app status and the audit log.
3. If the dry run reports a missing scope, the Dropbox app needs `files.content.write` (a new token).
4. Separate approval to set `SECVAL_SECOND_COPY=on`. After the first real run, restore the downloaded files in
   an isolated folder with "Restore" above; only then does the Dropbox check count SecVal as backed up.
