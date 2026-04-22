-- Messages composer upgrade: custom subject + audience picker
-- Adds two columns so a team member can send from DCC with:
--   • a custom subject that overrides the generic email subject
--   • an audience array picking one/both of {client, attorney}
-- Then rewrites dispatch_message_notifications to honor both:
--   • NEW.subject, if present, becomes the outbound email's subject
--   • 'attorney' in NEW.audience fans out to attorney_assignments too
-- Safe to re-run: uses IF NOT EXISTS and CREATE OR REPLACE.

alter table public.messages
  add column if not exists subject text,
  add column if not exists audience text[] not null default array['client']::text[];

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'messages_audience_check' and conrelid = 'public.messages'::regclass
  ) then
    alter table public.messages
      add constraint messages_audience_check
      check (audience <@ array['client', 'attorney']);
  end if;
end $$;

create or replace function public.dispatch_message_notifications()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  resend_key text;
  deal_name text;
  deal_name_short text;
  deal_case text;
  deal_county text;
  dcc_url text := 'https://app.refundlocators.com/';
  portal_url text := 'https://app.refundlocators.com/portal.html';
  attorney_portal_url text := 'https://app.refundlocators.com/attorney-portal.html';
  body_preview text;
  sender_display text;
  subject text;
  email_html text;
  ca record;
  aa record;
  team_email text := 'nathan@refundlocators.com';
  default_subject_in text;
  default_subject_out text;
  aud text[];
begin
  if NEW.deal_id like 'sf-test-%' or NEW.deal_id like 'test-%' then
    return NEW;
  end if;

  begin
    select decrypted_secret into resend_key
    from vault.decrypted_secrets where name = 'resend_api_key' limit 1;
  exception when others then
    resend_key := null;
  end;
  if resend_key is null then return NEW; end if;

  select name, meta->>'courtCase', meta->>'county'
    into deal_name, deal_case, deal_county
  from public.deals where id = NEW.deal_id;
  deal_name_short := split_part(coalesce(deal_name, NEW.deal_id), ' - ', 1);

  body_preview := substr(coalesce(NEW.body, ''), 1, 400);
  sender_display := coalesce(NEW.sender_name,
    case NEW.sender_role
      when 'client' then 'your client'
      when 'attorney' then 'counsel'
      else 'RefundLocators team'
    end);

  aud := coalesce(NEW.audience, array['client']::text[]);

  -- ─── Direction A: client or attorney → team ─────────────
  if NEW.sender_role in ('client', 'attorney') then
    default_subject_in := format('[RefundLocators] New message from %s on %s',
      case NEW.sender_role when 'client' then 'client' else 'counsel' end,
      deal_name_short);
    subject := coalesce(NEW.subject, default_subject_in);

    email_html := format($html$
<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#1a1a1a;background:#fbf8f1;margin:0;padding:24px 16px;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5dfd0;">
    <div style="background:linear-gradient(135deg,#0b1f3a 0%%,#17355e 100%%);padding:22px 28px;color:#fffcf5;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.14em;color:#d8b560;text-transform:uppercase;margin-bottom:6px;">RefundLocators · New %s message</div>
      <div style="font-family:Georgia,serif;font-size:22px;line-height:1.25;font-weight:500;letter-spacing:-0.015em;">%s sent you a message</div>
    </div>
    <div style="padding:22px 28px;">
      <div style="padding:14px 16px;background:#f4ecdc;border-left:3px solid #c9a24a;border-radius:6px;margin-bottom:18px;">
        <div style="font-size:11px;font-weight:700;color:#6b6b6b;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px;">Case</div>
        <div style="font-weight:600;color:#0b1f3a;">%s</div>
        <div style="font-size:12px;color:#6b6b6b;margin-top:2px;">%s%s</div>
      </div>
      <div style="font-size:15px;line-height:1.6;color:#1a1a1a;white-space:pre-wrap;border:1px solid #e5dfd0;border-radius:8px;padding:16px;background:#fafafa;">%s</div>
      <div style="text-align:center;margin:24px 0 12px;">
        <a href="%s" style="display:inline-block;background:#0b1f3a;color:#fffcf5;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Reply in DCC</a>
      </div>
      <p style="font-size:12px;color:#6b6b6b;line-height:1.6;text-align:center;margin:18px 0 0;">
        Opens Deal Command Center. Navigate to the case and reply in the Messages tab — your reply goes straight back to %s.
      </p>
    </div>
  </div>
</body></html>
    $html$,
      case NEW.sender_role when 'client' then 'client' else 'counsel' end,
      sender_display,
      deal_name_short,
      coalesce(deal_case, 'no case number'),
      case when deal_county is not null then ' · ' || deal_county || ' County' else '' end,
      body_preview,
      dcc_url,
      case NEW.sender_role when 'client' then 'the client' else 'counsel' end
    );

    perform net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || resend_key
      ),
      body := jsonb_build_object(
        'from', 'RefundLocators <hello@refundlocators.com>',
        'to', team_email,
        'subject', subject,
        'html', email_html,
        'reply_to', team_email
      )
    );

    insert into public.activity (deal_id, user_id, action, visibility)
    values (NEW.deal_id, null,
      'Message notification emailed to ' || team_email || ' (' || NEW.sender_role || ')',
      array['team']);

  -- ─── Direction B: team → client / attorney ──────────────
  elsif NEW.sender_role in ('admin', 'user', 'va') then
    default_subject_out := coalesce(NEW.subject, '[RefundLocators] New message from Nathan');

    -- Fan out to clients on this deal (if 'client' is in audience)
    if 'client' = any(aud) then
      for ca in
        select email, prefs from public.client_access
        where deal_id = NEW.deal_id and enabled = true
          and coalesce((prefs->>'notify_email')::boolean, true)
          and email is not null
      loop
        email_html := format($html$
<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#1a1a1a;background:#fbf8f1;margin:0;padding:24px 16px;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5dfd0;">
    <div style="background:linear-gradient(135deg,#0b1f3a 0%%,#17355e 100%%);padding:22px 28px;color:#fffcf5;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.14em;color:#d8b560;text-transform:uppercase;margin-bottom:6px;">RefundLocators</div>
      <div style="font-family:Georgia,serif;font-size:22px;line-height:1.25;font-weight:500;letter-spacing:-0.015em;">%s</div>
    </div>
    <div style="padding:22px 28px;">
      <div style="font-size:15px;line-height:1.6;color:#1a1a1a;white-space:pre-wrap;border:1px solid #e5dfd0;border-radius:8px;padding:16px;background:#fafafa;">%s</div>
      <div style="text-align:center;margin:24px 0 12px;">
        <a href="%s" style="display:inline-block;background:#0b1f3a;color:#fffcf5;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Open your case portal</a>
      </div>
      <p style="font-size:12px;color:#6b6b6b;line-height:1.6;text-align:center;margin:18px 0 0;">
        Reply inside your portal and Nathan gets it immediately. Questions? Call <a href="tel:+15139518855" style="color:#17355e;">(513) 951-8855</a>.
      </p>
    </div>
  </div>
</body></html>
        $html$, default_subject_out, body_preview, portal_url);

        perform net.http_post(
          url := 'https://api.resend.com/emails',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || resend_key
          ),
          body := jsonb_build_object(
            'from', 'RefundLocators <hello@refundlocators.com>',
            'to', ca.email,
            'subject', default_subject_out,
            'html', email_html,
            'reply_to', team_email
          )
        );

        insert into public.activity (deal_id, user_id, action, visibility)
        values (NEW.deal_id, null,
          'Message notification emailed to ' || ca.email || ' (client)',
          array['team']);
      end loop;
    end if;

    -- Fan out to attorneys on this deal (if 'attorney' is in audience)
    if 'attorney' = any(aud) then
      for aa in
        select email from public.attorney_assignments
        where deal_id = NEW.deal_id and enabled = true
          and email is not null
      loop
        email_html := format($html$
<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#1a1a1a;background:#f5f1e8;margin:0;padding:24px 16px;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #dcd3bc;">
    <div style="background:linear-gradient(135deg,#0b1f3a 0%%,#17355e 100%%);padding:22px 28px;color:#fffcf5;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.14em;color:#d8b560;text-transform:uppercase;margin-bottom:6px;">RefundLocators · Counsel Portal</div>
      <div style="font-family:Georgia,serif;font-size:22px;line-height:1.25;font-weight:500;letter-spacing:-0.015em;">%s</div>
    </div>
    <div style="padding:22px 28px;">
      <div style="padding:14px 16px;background:#ebe3d1;border-left:3px solid #0b1f3a;border-radius:6px;margin-bottom:18px;">
        <div style="font-size:11px;font-weight:700;color:#6b6b6b;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px;">Case</div>
        <div style="font-weight:600;color:#0b1f3a;">%s</div>
        <div style="font-size:12px;color:#6b6b6b;margin-top:2px;">%s%s</div>
      </div>
      <div style="font-size:15px;line-height:1.6;color:#1a1a1a;white-space:pre-wrap;border:1px solid #dcd3bc;border-radius:8px;padding:16px;background:#fafafa;">%s</div>
      <div style="text-align:center;margin:24px 0 12px;">
        <a href="%s" style="display:inline-block;background:#0b1f3a;color:#fffcf5;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Open counsel portal</a>
      </div>
      <p style="font-size:12px;color:#6b6b6b;line-height:1.6;text-align:center;margin:18px 0 0;">
        Questions? Call Nathan at <a href="tel:+15139518855" style="color:#17355e;">(513) 951-8855</a>.
      </p>
    </div>
  </div>
</body></html>
        $html$,
          default_subject_out,
          deal_name_short,
          coalesce(deal_case, 'no case number'),
          case when deal_county is not null then ' · ' || deal_county || ' County' else '' end,
          body_preview,
          attorney_portal_url
        );

        perform net.http_post(
          url := 'https://api.resend.com/emails',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || resend_key
          ),
          body := jsonb_build_object(
            'from', 'RefundLocators <hello@refundlocators.com>',
            'to', aa.email,
            'subject', default_subject_out,
            'html', email_html,
            'reply_to', team_email
          )
        );

        insert into public.activity (deal_id, user_id, action, visibility)
        values (NEW.deal_id, null,
          'Message notification emailed to ' || aa.email || ' (attorney)',
          array['team']);
      end loop;
    end if;
  end if;

  return NEW;
end;
$function$;
