# SecVal second copy (Dropbox): key custody and restore

Off unless `SECVAL_SECOND_COPY=on` (or `dryrun`, which writes nothing; see "Activation"). Daily, into `/backups nov26/secval/DB` and `/backups nov26/secval/CODE`, 14 days kept.

## The key
- `SECVAL_BACKUP_KEY` (at least 32 characters) is the only key. It is NOT derived from the Backblaze (Litestream) secret, so losing or leaking one never exposes the other.
- Set it once as a Render secret. Livio keeps a copy in his password manager: without it the Dropbox copies cannot be read, and nobody else holds it.
- No key set = no copy is made (never uploaded unencrypted).

## What is in each copy
- `NNNNNN-secval-db.dump.enc`: the SQLite store (`VACUUM INTO`), gzip, AES-256-GCM.
- `NNNNNN-secval-code.zip.enc`: SOURCE ONLY. An allowlist of release files (root config files and `server/`, `public/`, `scripts/`, `test/` with listed extensions). Hidden files, `.env*`, keys, certificates, credentials, databases, dumps, logs and symlinks are refused. 2 MiB per file, 32 MiB and 2000 files total. Rebuild needs `npm ci` and the server secrets.
- `NNNNNN-secval-<kind>.manifest.json`: backup id, SHA-256, size, Dropbox `content_hash`, source commit, key id, file list, the creation-time restore result, and an HMAC-SHA256 signature (key derived from `SECVAL_BACKUP_KEY`, separate from the encryption key). The code copy is source only: it is not a runnable system (no `node_modules`, no secrets, no database).

## What counts as a validated copy (the check behind the "2 copies" cell)
A SecVal file counts only when ALL of these hold:

| When | Check | Where |
|---|---|---|
| Creation (once per copy) | Upload, download back, SHA-256 equal; decrypt; database opens with `PRAGMA integrity_check` = ok, or every code-zip entry's CRC checks. Result written into the manifest, which is then signed. No key = no signature = the run fails. | `runSecondCopy`, `server/backup/secondCopy.ts` |
| Daily check (every time) | Manifest present and downloaded; signature valid with the key on the checking server; it names this exact file (path, app, kind); the size and Dropbox `content_hash` Dropbox reports NOW equal the signed values. | `verifySecvalCopies` + `verifyCopy`, `server/backup/dropbox.ts`, `server/backup/attestation.ts` |
| Count | 2 different days of DB and of code inside 8 days, newest at most 2 days old. | `judge` |

So: a missing, unsigned, edited or other-key manifest, changed or resized stored bytes, or a missing key on the checker means NOT counted, and the cell shows why. The daily check proves the bytes are the ones restored at creation; it does not re-run the restore. A full restore of the real files is the separate isolated drill below. Tests: "verified at check time" in `test/backup-second-copy.test.ts` (tampered manifest, tampered content, other size, other key, no key, missing manifest, and two real runs counted).

## Restore (isolated, never onto production)
1. Download the `.enc` file and its manifest from Dropbox; check the file's SHA-256 against the manifest.
2. Decrypt with the key (same code as the app): `decrypt()` in `server/backup/secondCopy.ts` with `backupKey({ SECVAL_BACKUP_KEY })`.
3. Database: gunzip, write to a new file, open it read-only, run `PRAGMA integrity_check` (expect `ok`).
4. Code: `readZip()` checks every entry's CRC and refuses unsafe names; extract to an empty folder, `npm ci`, `npx tsc --noEmit`.
The test `isolated restore` in `test/backup-second-copy.test.ts` runs steps 2-4 on every check.

## Existing safeguards vs the 2 DB + 2 code requirement (today)
| | DB | Code |
|---|---|---|
| In force today | Litestream to Backblaze (1 copy, restore drill) | GitHub (1 home) |
| This PR adds, dormant | Dropbox encrypted copy | Dropbox source archive |
| Meets "2 validated DB + 2 validated code"? | NO until step 4 below has run and been checked | NO until step 4 below has run and been checked |

The release of this code does NOT meet the standard 2 DB + 2 code gate and does not claim to. No exception or waiver is granted here; one would need Livio's explicit approval.

## Retention
The newest 14 dated copies of each kind are kept. The job removes only its own older dated files (`NNNNNN-secval-...` and their manifests), never anything else; a removed file stays in Dropbox "Deleted files" for 30 days.

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
4. Separate approval to set `SECVAL_SECOND_COPY=on`. From the second day the check can count SecVal copies (signed
   and byte-checked, see above). Before calling the requirement met, restore the first real files in an isolated
   folder with "Restore" above and record the result.

Each step needs Livio's explicit approval naming the exact SHA (step 1) or the exact setting (steps 2 and 4).
