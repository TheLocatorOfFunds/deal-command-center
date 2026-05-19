-- Public bucket for inbound MMS (Twilio) and iMessage attachments (mac_bridge).
-- Both inbound paths download the original media (auth'd to Twilio / read from
-- ~/Library/Messages/Attachments), upload here under a random uuid path, and
-- store the resulting public URL on messages_outbound.media_url.
--
-- Public read is intentional and matches the rvm-audio bucket pattern: the
-- DCC comms thread renders `<img src={m.media_url}>` directly, so the URL
-- needs to work without re-signing. Privacy comes from random uuid filenames
-- (effectively unguessable) — the messages themselves are already RLS-scoped
-- on messages_outbound, this bucket only stores the attachment bytes.
--
-- Only service role writes (edge functions / bridge use service key).

insert into storage.buckets (id, name, public)
values ('inbound-media', 'inbound-media', true)
on conflict (id) do nothing;
