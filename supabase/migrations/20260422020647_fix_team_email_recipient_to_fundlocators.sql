-- refundlocators.com has no MX records, so all outbound notifications to
-- nathan@refundlocators.com silently bounce. Until Cloudflare Email Routing
-- is enabled (which would forward @refundlocators.com mail to Nathan's real
-- inbox and restore brand consistency), switch the trigger recipients to
-- nathan@fundlocators.com (Google Workspace, MX-backed, currently read).
-- Sender stays hello@refundlocators.com because that's Resend-verified via
-- DKIM and doesn't require MX on the domain.

do $$
declare
  src text;
begin
  -- dispatch_message_notifications: team_email + reply_to
  select pg_get_functiondef('public.dispatch_message_notifications'::regproc) into src;
  src := replace(src, 'nathan@refundlocators.com', 'nathan@fundlocators.com');
  execute src;

  -- send_daily_digest: morning digest recipient
  select pg_get_functiondef('public.send_daily_digest'::regproc) into src;
  src := replace(src, 'nathan@refundlocators.com', 'nathan@fundlocators.com');
  execute src;
end $$;
