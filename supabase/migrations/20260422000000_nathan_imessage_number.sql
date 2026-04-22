-- Add Nathan's business iPhone number to the phone_numbers registry.
-- Messages synced by the Mac Mini bridge will use this as from_number.
-- gateway = 'mac_bridge' distinguishes it from Twilio numbers so the
-- send-sms Edge Function knows not to route it through Twilio.

alter table public.phone_numbers
  add column if not exists gateway text not null default 'twilio';

insert into public.phone_numbers (label, number, active, gateway)
values ('Nathan iPhone', '+15135162306', true, 'mac_bridge')
on conflict (number) do update
  set label = excluded.label,
      gateway = excluded.gateway,
      active = true;
