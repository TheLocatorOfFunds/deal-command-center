-- Client docket-event notification emails
--
-- When a non-backfill docket event lands on a matched deal, email clients
-- for the court events that actually matter to them (hearing_scheduled,
-- hearing_continued, judgment_entered, disbursement_ordered, disbursement_paid).
--
-- Skips:
--   - is_backfill = true  (history replay — no spam)
--   - event_type not in client-facing set  (internal events like docket_updated)
--   - Deals with no enabled client_access rows with email
--   - Test deals
--
-- Same net.http_post → Resend pattern as dispatch_message_notifications.

create or replace function public.notify_client_docket_event()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  resend_key    text;
  portal_url    text := 'https://app.refundlocators.com/portal.html';
  team_phone    text := '(513) 951-8855';
  ca            record;
  deal_name_short text;
  subject_line  text;
  headline      text;
  detail        text;
  email_html    text;
  client_facing_events text[] := array[
    'disbursement_ordered',
    'disbursement_paid',
    'hearing_scheduled',
    'hearing_continued',
    'judgment_entered'
  ];
begin
  -- Only client-facing events, skip backfill
  if NEW.is_backfill = true then return NEW; end if;
  if not (NEW.event_type = any(client_facing_events)) then return NEW; end if;
  -- Need a matched deal to look up
  if NEW.deal_id is null then return NEW; end if;
  -- Skip test deals
  if NEW.deal_id like 'sf-test-%' or NEW.deal_id like 'test-%' then return NEW; end if;

  begin
    select decrypted_secret into resend_key
    from vault.decrypted_secrets where name = 'resend_api_key' limit 1;
  exception when others then resend_key := null; end;
  if resend_key is null then return NEW; end if;

  select split_part(coalesce(name, id), ' - ', 1)
    into deal_name_short
  from public.deals where id = NEW.deal_id;

  -- event_type → subject + headline + plain-English explanation
  case NEW.event_type
    when 'hearing_scheduled' then
      subject_line := '[RefundLocators] A court hearing has been scheduled on your case';
      headline     := 'A court hearing has been scheduled';
      detail       := 'The court has set a hearing date related to your surplus funds case. Our attorney will attend on your behalf — you do not need to be present. We''ll send you an update after the hearing with the outcome and what happens next.';

    when 'hearing_continued' then
      subject_line := '[RefundLocators] Your court hearing has been rescheduled';
      headline     := 'Your court hearing has been rescheduled';
      detail       := 'Your scheduled court hearing has been continued (rescheduled) to a later date. This is a normal and common part of the court process and does not affect your claim. Our attorney will appear at the rescheduled date. No action is needed from you.';

    when 'judgment_entered' then
      subject_line := '[RefundLocators] A court judgment has been entered on your case';
      headline     := 'A court judgment has been entered';
      detail       := 'The court has entered a judgment related to your surplus funds case. This is a significant step forward. Our attorney is reviewing the details and will reach out if any action is needed. You can view court updates in your case portal.';

    when 'disbursement_ordered' then
      subject_line := '[RefundLocators] The court has ordered your funds to be disbursed';
      headline     := 'Disbursement ordered by the court!';
      detail       := 'Great news — the court has issued a disbursement order for your surplus funds. This means the judge has approved the release of your money. The next step is for the funds to be processed and distributed. We''ll be in touch as soon as payment is ready.';

    when 'disbursement_paid' then
      subject_line := '[RefundLocators] Your surplus funds have been paid out';
      headline     := 'Your funds have been paid out!';
      detail       := 'Your surplus funds have officially been disbursed. Our team will be reaching out to confirm receipt and coordinate your payment. If you have any questions or haven''t received your funds, please don''t hesitate to contact us.';

    else
      return NEW;
  end case;

  -- Fan out to every enabled client on this deal
  for ca in
    select email, prefs
    from public.client_access
    where deal_id = NEW.deal_id
      and enabled = true
      and email is not null
      and coalesce((prefs->>'notify_email')::boolean, true) = true
  loop
    email_html := format($html$
<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#1a1a1a;background:#fbf8f1;margin:0;padding:24px 16px;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5dfd0;box-shadow:0 1px 2px rgba(11,31,58,.06),0 8px 24px rgba(11,31,58,.04);">

    <div style="background:linear-gradient(135deg,#0b1f3a 0%%,#17355e 100%%);padding:22px 28px;color:#fffcf5;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.14em;color:#d8b560;text-transform:uppercase;margin-bottom:6px;">RefundLocators · Court Update</div>
      <div style="font-family:Georgia,serif;font-size:22px;line-height:1.25;font-weight:500;letter-spacing:-0.015em;">%s</div>
    </div>

    <div style="padding:22px 28px;">
      <div style="padding:12px 16px;background:#f4ecdc;border-left:3px solid #c9a24a;border-radius:6px;margin-bottom:18px;">
        <div style="font-size:11px;font-weight:700;color:#6b6b6b;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:3px;">Your Case</div>
        <div style="font-weight:600;color:#0b1f3a;">%s</div>
      </div>

      <p style="font-size:15px;line-height:1.65;color:#1a1a1a;margin:0 0 20px;">%s</p>

      <div style="text-align:center;margin:24px 0 16px;">
        <a href="%s" style="display:inline-block;background:#0b1f3a;color:#fffcf5;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">View your case portal →</a>
      </div>

      <p style="font-size:12px;color:#6b6b6b;line-height:1.6;text-align:center;margin:0;">
        Questions? Call us at <a href="tel:+15139518855" style="color:#17355e;">%s</a> or reply to this email.
      </p>
    </div>

    <div style="background:#f4ecdc;border-top:1px solid #e5dfd0;padding:14px 28px;text-align:center;">
      <p style="font-size:11px;color:#9a9a9a;margin:0;">
        RefundLocators · Surplus Fund Recovery Specialists<br/>
        <a href="https://refundlocators.com" style="color:#9a9a9a;">refundlocators.com</a>
      </p>
    </div>

  </div>
</body></html>
    $html$,
      headline,
      deal_name_short,
      detail,
      portal_url,
      team_phone
    );

    perform net.http_post(
      url     := 'https://api.resend.com/emails',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || resend_key
      ),
      body    := jsonb_build_object(
        'from',     'RefundLocators <hello@refundlocators.com>',
        'to',       ca.email,
        'subject',  subject_line,
        'html',     email_html,
        'reply_to', 'nathan@fundlocators.com'
      )
    );

    insert into public.activity (deal_id, user_id, action, visibility)
    values (NEW.deal_id, null,
      'Docket notification emailed to ' || ca.email || ' (event: ' || NEW.event_type || ')',
      array['team']);

  end loop;

  return NEW;
end;
$$;

-- Drop + recreate trigger on docket_events table
drop trigger if exists tg_notify_client_docket_event on public.docket_events;
create trigger tg_notify_client_docket_event
  after insert on public.docket_events
  for each row
  execute function public.notify_client_docket_event();

comment on function public.notify_client_docket_event() is
  'Emails enabled clients when a client-facing docket event lands on their deal.
   Skips backfill events. Client-facing set: hearing_scheduled, hearing_continued,
   judgment_entered, disbursement_ordered, disbursement_paid.
   Created 2026-05-05.';
