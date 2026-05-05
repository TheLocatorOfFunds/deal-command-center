# Weekly DB backup → Cloudflare R2 — setup

The workflow `.github/workflows/weekly-db-backup.yml` is committed and ready.
It needs **6 GitHub Secrets** before it can run. This is the dashboard-click
walkthrough.

## Cost recap

- Cloudflare R2 storage: ~$0.015/GB/month. A typical Supabase DB this size
  + 16 weekly backups gzipped will cost a few cents to a few dollars per month.
- No egress fees on R2 (unlike S3).
- GitHub Actions: free tier covers this — one short job per week.
- **Total expected: under $5/mo. Compare to PITR's $115/mo.**

## What you need to do (~25 min, one time)

### 1. Create the R2 bucket

1. Open https://dash.cloudflare.com → your account → **R2 Object Storage**
2. Click **Create bucket**
3. Name: `fundlocators-backups` (or any name — note it down)
4. Location: **Automatic** is fine
5. Click **Create bucket**

### 2. Get the R2 endpoint URL

Still in R2:
1. Click the bucket you just made
2. Click **Settings** tab
3. Find **S3 API** section — copy the value labeled "Endpoint" (looks like `https://<accountid>.r2.cloudflarestorage.com`)
4. Save it to disk first so it doesn't get lost in chat:

   ```bash
   nano ~/Documents/Claude/secrets/r2-endpoint.txt
   # paste the endpoint URL
   # Ctrl+O Enter, Ctrl+X
   ```

### 3. Generate an R2 API token

Still in R2:
1. Click **Manage R2 API Tokens** (top-right or sidebar)
2. Click **Create API token**
3. Token name: `dcc-weekly-backup`
4. Permissions: **Object Read & Write**
5. Specify bucket: select the `fundlocators-backups` bucket only (don't grant
   account-wide access — least privilege)
6. TTL: leave blank (no expiry)

**Before you click Create**, prep two save-to-disk files (so the values
don't bounce through chat or the clipboard):

```bash
nano ~/Documents/Claude/secrets/r2-access-key.txt
# (will paste the access key here in a moment)
# Ctrl+O Enter, Ctrl+X

nano ~/Documents/Claude/secrets/r2-secret-key.txt
# (will paste the secret here in a moment)
# Ctrl+O Enter, Ctrl+X
```

Now click **Create API Token**. The result page shows:
- **Access Key ID** → copy into `r2-access-key.txt`
- **Secret Access Key** → copy into `r2-secret-key.txt` ← shown ONCE, can't be re-shown

### 4. Get the Supabase DB connection string

1. Open https://supabase.com/dashboard/project/rcfaashkfpurkvtmsmeb/settings/database
2. Scroll to **Connection string**
3. Pick the **Direct connection** tab (NOT pooler — pg_dump needs direct)
4. Copy the URI (starts with `postgres://postgres.rcfaashkfpurkvtmsmeb:...@aws-0-us-east-2.pooler.supabase.com:5432/postgres` or similar)
5. **The password is masked as `[YOUR-PASSWORD]`.** You'll need to substitute the real one.
6. If you don't remember the password:
   - Same page → scroll to **Database password** → click **Reset password**
   - Save the new password to disk first:
     ```bash
     nano ~/Documents/Claude/secrets/supabase-db-password.txt
     # Ctrl+O, Ctrl+X
     ```
   - **Heads up:** resetting will break any existing service that connects directly. Castle's `config/.env` has the service role key, not this password — so probably nothing will break. But check before you reset.

7. Build the full connection string (substitute `[YOUR-PASSWORD]`):
   ```bash
   nano ~/Documents/Claude/secrets/supabase-db-url.txt
   # paste the full URI with the real password substituted in
   # e.g. postgres://postgres.rcfaashkfpurkvtmsmeb:THE-PASSWORD@aws-0-us-east-2.pooler.supabase.com:5432/postgres
   # Ctrl+O, Ctrl+X
   ```

### 5. Add the 6 GitHub Secrets

1. Open https://github.com/TheLocatorOfFunds/deal-command-center/settings/secrets/actions
2. Click **New repository secret** for each of these:

| Name                      | Value (paste from the .txt file you saved) |
| ------------------------- | ------------------------------------------ |
| `SUPABASE_DB_URL`         | contents of `supabase-db-url.txt` |
| `R2_ACCESS_KEY_ID`        | contents of `r2-access-key.txt` |
| `R2_SECRET_ACCESS_KEY`    | contents of `r2-secret-key.txt` |
| `R2_BUCKET`               | `fundlocators-backups` (or whatever name you used) |
| `R2_ENDPOINT`             | contents of `r2-endpoint.txt` |
| `SUPABASE_URL`            | `https://rcfaashkfpurkvtmsmeb.supabase.co` |

Optional 7th secret (recommended) so backup failures light up the ⚠ badge in DCC:

| `SUPABASE_SERVICE_ROLE_KEY` | Service role key from Supabase dashboard → Settings → API → "service_role" |

Save it to disk first (`nano ~/Documents/Claude/secrets/supabase-service-key.txt`)
then paste from there into the GitHub Secret form.

### 6. First-run smoke test

1. Open https://github.com/TheLocatorOfFunds/deal-command-center/actions/workflows/weekly-db-backup.yml
2. Click **Run workflow** → **Run workflow** (use main branch)
3. Wait ~2-5 minutes
4. The run should turn green and the log will show "Uploaded s3://fundlocators-backups/weekly/dcc-backup-...dump.gz"
5. Verify in Cloudflare R2 dashboard — bucket should now contain one file under `weekly/`

If it failed, the GitHub Actions log will tell you why. Most common: typo in
`SUPABASE_DB_URL` (password chars need URL-encoding if they include `@`,
`:`, `/`, `?`, `#`).

### 7. Clean up the local secrets folder

Once GitHub Secrets are populated and the smoke test passed, you can shred
the local files:

```bash
shred -u ~/Documents/Claude/secrets/r2-*.txt
shred -u ~/Documents/Claude/secrets/supabase-*.txt
```

(Or move them into 1Password / a password manager. Up to you.)

## How recovery works (the day you actually need this)

The `.dump.gz` files in R2 are full Postgres custom-format dumps. To
restore on a fresh Supabase project:

```bash
# Download the most recent weekly backup
aws s3 cp s3://fundlocators-backups/weekly/dcc-backup-2026-04-30T03-00-00Z.dump.gz . \
  --endpoint-url https://<accountid>.r2.cloudflarestorage.com

# Decompress
gunzip dcc-backup-*.dump.gz

# Restore (point at fresh DB)
pg_restore --no-owner --no-privileges \
  -d "postgres://postgres.<NEW-PROJECT>:<PWD>@<NEW-HOST>:5432/postgres" \
  dcc-backup-*.dump
```

For a partial restore (e.g. just one accidentally-deleted table), use
`pg_restore --table=<name>` instead of restoring the whole thing.

## What the workflow doesn't cover

- **Storage objects** in `deal-docs`, `team-chat`, `screen-recordings`,
  `avatars` buckets — pg_dump only captures the metadata in `documents`/etc.
  rows, not the actual files. If you want full storage backup too, that's
  a separate `aws s3 sync` job (can add later).
- **Edge Function source** — lives in git already.
- **Auth users** — included in the dump (Postgres `auth.users` table).
