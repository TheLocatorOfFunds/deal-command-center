---
# Session 2025-01-XX — Phase 2 Contacts/CRM build + Phase 3 Library notes

**Owner:** Nathan  
**Source JSONL:** `/Users/alexanderthegreat/.claude/projects/-Users-alexanderthegreat-Documents-Claude/51dcc07a-62e8-43d9-83cd-bb373aeec52c.jsonl`  
**Status:** DRAFT (auto-generated backfill, needs review)

## What we set out to do
Nathan moved from personal Claude project to team version and confirmed both TRANSFER_TO_NEW_CLAUDE_CODE.md and CASTLE_JOHN_DUNN_PROMPT.md were readable. He then requested Phase 2 (Contacts/CRM) implementation plus notes on what Phase 3 (document library) would look like.

## Decisions made (durable — these change behavior going forward)
- **Contacts system scope:** one table for all external parties (attorneys, title companies, VAs, referral sources, vendors, investors, press) who aren't clients but interact with deals
- **Contact-deal linking:** `contact_deals` M:N junction table allows multi-deal association per contact
- **Role gating for contacts:** admins see all fields, VAs see all except `financial_notes`, attorneys/clients have no Contacts access
- **Contact roles enum:** standardized to `attorney`, `title_company`, `court_officer`, `vendor`, `investor`, `referral_source`, `media`, `other`
- **Deferred to later:** CSV import, email sync, calendar sync, segmented saved views (easy to tack on once base is solid)

## Gotchas hit (non-obvious; future sessions need to know)
- (None surfaced during session — migration/RLS confirmed working before UI began)

## Files / systems touched
- **Repo files:** `index.html` (added Contacts view/modal + per-deal ContactsTab)
- **DB migrations:** `create_contacts_and_contact_deals` (two tables, RLS policies, updated_at triggers, realtime publication)
- **Edge functions deployed:** (none)
- **External systems:** (none)

## Open follow-ups
- [ ] Finish ContactsModal component (list + add/edit form, tag filters)
- [ ] Wire ContactsTab in deal detail (linked contacts + quick-add button)
- [ ] Add contact quick-actions (email, call, view linked deals)
- [ ] Document Phase 3 Library scope/structure (company-wide doc repository replacing Google Drive for SOPs, templates, contracts)