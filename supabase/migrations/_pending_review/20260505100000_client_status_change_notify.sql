-- Client status-change notification emails
--
-- When a deal's status changes, email every enabled client on that deal.
-- Fires only on forward-progress statuses (not dead, not urgent, not new-lead).
-- Respects client_access.prefs->>'notify_email' (default true).
-- Uses net.http_post → Resend, same pattern as dispatch_message_notifications.
--
-- Status → plain-English mapping is inside the function body.

create or replace function public.notify_client_status_change()
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
  notifiable_statuses text[] := array[
    'signed','filed','probate','hearing-set','awaiting-distribution','recovered'
  ];
begin
  -- Only fire when status actually changed and new status is client-notifiable
  if OLD.status = NEW.status then return NEW; end if;
  if not (NEW.status = any(notifiable_statuses)) then return NEW; end if;
  -- Skip test deals
  if NEW.id like 'sf-test-%' or NEW.id like 'test-%' then return NEW; end if;

  begin
    select decrypted_secret into resend_key
    from vault.decrypted_secrets where name = 'resend_api_key' limit 1;
  exception when others then resend_key := null; end;
  if resend_key is null then return NEW; end if;

  deal_name_short := split_part(coalesce(NEW.name, NEW.id), ' - ', 1);

  -- Status → subject + headline + detail copy
  case NEW.status
    when 'signed' then
      subject_line := '[RefundLocators] We''ve started working on your case';
      headline     := 'We''ve started working on your case';
      detail       := 'Your agreement is in and our team has begun preparing the paperwork needed to file your claim with the court. We''ll update you at each major milestone — you can always check your current status in the portal below.';

    when 'filed' then
      subject_line := '[RefundLocators] Your claim has been filed with the court';
      headline     := 'Your claim has been filed';
      detail       := 'We''ve filed your surplus funds claim with the probate court. The court will now review the filing and schedule the next steps. This process can take several weeks — we''ll notify you as things progress. You don''t need to do anything right now.';

    when 'probate' then
      subject_line := '[RefundLocators] Your case is in probate proceedings';
      headline     := 'Your case is in probate';
      detail       := 'Your case is now going through the probate court process. This is a normal part of recovering surplus funds from a foreclosure sale. Our attorney is monitoring the case and will act on your behalf at every step. We''ll keep you informed.';

    when 'hearing-set' then
      subject_line := '[RefundLocators] A court hearing has been scheduled';
      headline     := 'A court hearing has been scheduled';
      detail       := 'The court has set a hearing date for your case. Our attorney will appear on your behalf — you do not need to attend. After the hearing we''ll send you an update on the outcome and what comes next.';

    when 'awaiting-distribution' then
      subject_line := '[RefundLocators] Your claim has been approved — payment incoming';
      headline     := 'Your claim has been approved!';
      detail       := 'The court has approved your surplus funds claim. Your case is now in the distribution phase, which means the funds are being prepared for release. This is the final stretch — we''ll be in touch as soon as your payment is ready.';

    when 'recovered' then
      subject_line := '[RefundLocators] Your funds have been recovered!';
      headline     := 'Your funds have been recovered!';
      detail       := 'We''re thrilled to share that your surplus funds have been successfully recovered. Our team will be reaching out shortly to coordinate your payment. Thank you for trusting RefundLocators to handle your case.';

    else
      return NEW; -- shouldn't reach here given notifiable_statuses check above
  end case;

  -- Fan out to every enabled client on this deal
  for ca in
    select email, prefs
    from public.client_access
    where deal_id = NEW.id
      and enabled = true
      and email is not null
      and coalesce((prefs->>'notify_email')::boolean, true) = true
  loop
    email_html := format($html$
<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#1a1a1a;background:#fbf8f1;margin:0;padding:24px 16px;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5dfd0;box-shadow:0 1px 2px rgba(11,31,58,.06),0 8px 24px rgba(11,31,58,.04);">

    <div style="background:linear-gradient(135deg,#0b1f3a 0%%,#17355e 100%%);padding:22px 28px;color:#fffcf5;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.14em;color:#d8b560;text-transform:uppercase;margin-bottom:6px;">RefundLocators · Case Update</div>
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
    values (NEW.id, null,
      'Status-change notification emailed to ' || ca.email || ' (status → ' || NEW.status || ')',
      array['team']);

  end loop;

  return NEW;
end;
$$;

-- Drop + recreate trigger on deals table
drop trigger if exists tg_notify_client_status_change on public.deals;
create trigger tg_notify_client_status_change
  after update of status on public.deals
  for each row
  execute function public.notify_client_status_change();

comment on function public.notify_client_status_change() is
  'Emails enabled clients when their deal status advances to a client-notifiable stage.
   Fires on deals.status UPDATE. Respects client_access.prefs->notify_email.
   Created 2026-05-05.';
