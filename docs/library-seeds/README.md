# Library seed source

Source markdowns for the initial seeding of the DCC Library (`library_documents` table + `library` storage bucket).

These files are **also** uploaded to the Library storage bucket. The repo copy is the version-controlled source of truth — edit here, then re-upload to bucket if you want changes to flow.

## Currently seeded (2026-04-26)

| File | Library title | Folder | Tags | Visibility | Storage path |
|---|---|---|---|---|---|
| `01-how-surplus-recovery-works.md` | How surplus recovery works | Client FAQ (id `766e4b1b-…`) | sop, lauren-ready, client-facing, intake | client | `sop/01-how-surplus-recovery-works.md` |
| `02-why-we-charge-a-contingency-fee.md` | Why we charge a contingency fee | Client FAQ | sop, lauren-ready, client-facing, objection:fee | client | `sop/02-why-we-charge-a-contingency-fee.md` |
| `03-what-happens-after-you-sign.md` | What happens after you sign | Client FAQ | sop, lauren-ready, client-facing, post-engagement, timeline | client | `sop/03-what-happens-after-you-sign.md` |

## Re-upload workflow (when you edit these)

```bash
PAT=$(jq -r '.mcpServers["supabase-dcc"].env.SUPABASE_ACCESS_TOKEN' \
  ~/Library/Application\ Support/Claude/claude_desktop_config.json)
PROJ="rcfaashkfpurkvtmsmeb"
SRK=$(curl -sS "https://api.supabase.com/v1/projects/$PROJ/api-keys" \
  -H "Authorization: Bearer $PAT" | jq -r '.[] | select(.name=="service_role") | .api_key')

# Re-upload (PUT overwrites, POST would 409 since file exists)
for f in 01-how-surplus-recovery-works 02-why-we-charge-a-contingency-fee 03-what-happens-after-you-sign; do
  curl -sS -X PUT "https://rcfaashkfpurkvtmsmeb.supabase.co/storage/v1/object/library/sop/$f.md" \
    -H "Authorization: Bearer $SRK" \
    -H "Content-Type: text/markdown" \
    --data-binary "@docs/library-seeds/$f.md"
done
```

After re-upload, also bump the `version` integer on the library_documents row + set `updated_at = now()` so consumers (Lauren's RAG, eventual UI) re-embed.

## Why these three first

- **Lauren-readiness:** when Justin builds Lauren intake-and-classify, she needs a knowledge base of FAQ-style content to retrieve via pgvector. These three cover the most common inbound question categories: "what is this?", "how much does it cost?", "what happens next?"
- **Client portal pin candidates:** all three are `visibility='client'` and could be pinned to a deal's client portal as on-demand reference material.
- **Voice consistency:** all written in Nathan's voice (warm, direct, no em-dashes, no exclamation points, plain punctuation) so the Lauren-paraphrased version sounds like the human.

## Future seeds to consider

These are placeholders — neither drafted nor uploaded yet:

- `kind='template'` engagement agreement (DocuSign-wired) — see `DOCUSIGN_ENGAGEMENT_TEMPLATE_SETUP.md`
- `kind='template'` authorization for surplus claim filing
- `kind='sop'` "Hamilton County filing checklist" (per-county procedure cheat sheets)
- `kind='sop'` "What to do when disbursement_ordered fires" (internal Nathan/VA playbook)
- `kind='video'` welcome video master copy (currently per-deal — could move to one library copy + pin to all client portals)
- `kind='image'` brand assets (logo variants, social cards)
