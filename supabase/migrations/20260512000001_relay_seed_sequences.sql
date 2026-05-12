-- FL Relay: seed ohio-surplus-v1, ohio-preforeclosure-v1, ohio-preauction-v1
-- sequences with steps, and the touch-1 opener A/B/C experiment.

-- ── Sequences ─────────────────────────────────────────────────────────────────

insert into relay.sequences (id, name, description) values
  (
    'ohio-surplus-v1',
    'Ohio Surplus Funds - v1',
    '7-step progressive disclosure sequence for Ohio surplus fund cases. Identity confirm opener, RVM backup, then 5 SMS touches progressively revealing case details. Gamification + loss aversion throughout. Contact data: first_name, last_name, county, street_address, case_number, case_month, case_year, agent_first_name.'
  ),
  (
    'ohio-preforeclosure-v1',
    'Ohio Pre-Foreclosure (Notice of Default) - v1',
    'Triggered when a notice of default is filed. Person is still in the home. Angle is awareness and options, not money. Tone is empathetic. Contact data: first_name, last_name, county, street_address, case_number, filing_month, filing_year, agent_first_name.'
  ),
  (
    'ohio-preauction-v1',
    'Ohio Pre-Auction (Auction Date Set) - v1',
    'Triggered when an auction date is set, ideally 30+ days out. Real urgency. Angle is time pressure and options before the date. Contact data: first_name, last_name, county, street_address, case_number, auction_date, days_until_auction, agent_first_name.'
  );

-- ── ohio-surplus-v1 steps ─────────────────────────────────────────────────────

insert into relay.sequence_steps (sequence_id, step_number, channel, delay_hours, message_template, notes) values
  ('ohio-surplus-v1', 1, 'sms', 0,
   'Hi, is this {{first_name}} {{last_name}} in {{county}} County?',
   'Identity confirm. County signals local knowledge. No business indicators. No STOP on opener.'),
  ('ohio-surplus-v1', 2, 'rvm', 8,
   null,
   'Evening RVM if no reply. Script: Ohio-based, saw a filing on their property, real person, happy to talk or meet.'),
  ('ohio-surplus-v1', 3, 'sms', 24,
   'Hey {{first_name}}, I''m a local investigator in Ohio and I have a file here with your name on it tied to a property matter in {{county}} County. I''m based in Ohio and wanted to make sure I had the right person before sending the details. {{agent_first_name}}',
   'Reveal: property matter + county. Local/real person signals. No money mention.'),
  ('ohio-surplus-v1', 4, 'sms', 48,
   '{{first_name}}, case {{case_number}} was filed {{case_month}} {{case_year}} in {{county}} County. Your address at {{street_address}} is connected to it. Happy to walk you through it by phone or in person. Reply YES and I''ll send the details.',
   'Reveal: real case number + address. Binary YES ask. In-person offer.'),
  ('ohio-surplus-v1', 5, 'sms', 72,
   '{{first_name}}, still have your file open. These cases have a window and I didn''t want you to miss it. We''re a local Ohio company, real people, and we can meet in person if that''s easier. Is there a better number to reach you?',
   'Soft deadline. Loss aversion. Local credibility. Asks for better number.'),
  ('ohio-surplus-v1', 6, 'sms', 96,
   '{{first_name}}, the {{county}} County record shows {{street_address}} with a potential recoverable amount. We''re based in Ohio and handle these personally, not a national operation. It''s not nothing. Reply YES if you want me to send the summary.',
   'Partial amount reveal. Local/personal framing. Avoids carrier filter words.'),
  ('ohio-surplus-v1', 7, 'sms', 96,
   '{{first_name}}, closing out your file {{case_number}} this week. If I don''t hear back I''ll mark it inactive and move on. No hard feelings, just wanted to give you every chance. {{agent_first_name}}',
   'Finality message. Loss aversion at maximum. No explicit ask.');

-- ── ohio-preforeclosure-v1 steps ──────────────────────────────────────────────

insert into relay.sequence_steps (sequence_id, step_number, channel, delay_hours, message_template, notes) values
  ('ohio-preforeclosure-v1', 1, 'sms', 0,
   'Hi, is this {{first_name}} {{last_name}} in {{county}} County?',
   'Same identity confirm opener.'),
  ('ohio-preforeclosure-v1', 2, 'rvm', 8,
   null,
   'Evening RVM. Script: Ohio-based, saw a filing on their property, wanted to reach out personally, happy to talk through options.'),
  ('ohio-preforeclosure-v1', 3, 'sms', 24,
   'Hey {{first_name}}, I''m a local investigator in Ohio and I came across a filing in {{county}} County tied to {{street_address}}. I work with Ohio homeowners when this happens and wanted to reach out personally. {{agent_first_name}}',
   'Reveal: filing exists, local, we work with people in this situation. No alarm, no dollar figures.'),
  ('ohio-preforeclosure-v1', 4, 'sms', 48,
   '{{first_name}}, the filing on {{street_address}} was recorded {{filing_month}} {{filing_year}} in {{county}} County. A lot of homeowners aren''t sure what it means or what options they have at this stage. Happy to walk through it with you by phone or in person.',
   'Reveal: filing date and address. Resource framing, not predatory. In-person offer.'),
  ('ohio-preforeclosure-v1', 5, 'sms', 72,
   '{{first_name}}, these cases tend to move faster than people expect once they''re filed. I''m local and have worked with a lot of {{county}} County homeowners in this situation. Is there a good time to talk?',
   'Time pressure without threat. Local credibility + social proof.'),
  ('ohio-preforeclosure-v1', 6, 'sms', 96,
   '{{first_name}}, still have your file here. I don''t want to bother you but I also didn''t want you to feel like you didn''t have anyone to call. We''re based in Ohio and can meet in person if that''s ever useful. {{agent_first_name}}',
   'Human, low pressure. Positions as resource not salesperson.'),
  ('ohio-preforeclosure-v1', 7, 'sms', 96,
   '{{first_name}}, closing out your file on {{street_address}}. If things change or you ever want to talk through options, feel free to reach back out. {{agent_first_name}}',
   'Soft close. Leaves door open since pre-foreclosure cases develop over months.');

-- ── ohio-preauction-v1 steps ──────────────────────────────────────────────────

insert into relay.sequence_steps (sequence_id, step_number, channel, delay_hours, message_template, notes) values
  ('ohio-preauction-v1', 1, 'sms', 0,
   'Hi, is this {{first_name}} {{last_name}} in {{county}} County?',
   'Same identity confirm opener.'),
  ('ohio-preauction-v1', 2, 'rvm', 8,
   null,
   'Evening RVM. Script: Ohio-based, saw a date set on their property, time-sensitive, wanted to reach out personally.'),
  ('ohio-preauction-v1', 3, 'sms', 24,
   'Hey {{first_name}}, I''m a local investigator in Ohio and I have a file here on {{street_address}} in {{county}} County. There''s a date attached to this case I wanted to make sure you were aware of. {{agent_first_name}}',
   'Reveal: date exists without naming it yet. Curiosity gap.'),
  ('ohio-preauction-v1', 4, 'sms', 48,
   '{{first_name}}, the property at {{street_address}} has an auction scheduled for {{auction_date}}. I work with Ohio homeowners in this situation and there are sometimes options available before a date like that. Happy to talk through it by phone or in person.',
   'Reveal: actual auction date. Options framing without over-promising.'),
  ('ohio-preauction-v1', 5, 'sms', 48,
   '{{first_name}}, the auction date on {{street_address}} is getting close. I''m local and have worked through situations like this with other {{county}} County homeowners. Is there a better number to reach you or a good time to talk?',
   'Urgency. Social proof. Compressed delay since time is actually running out.'),
  ('ohio-preauction-v1', 6, 'sms', 48,
   '{{first_name}}, we''re coming up on {{auction_date}} for {{street_address}}. I don''t want to pressure you but I also want to make sure you''re not caught off guard. We''re real people based in Ohio and can meet in person if that helps. Reply YES if you want to talk.',
   'Final pre-auction push. Named date + real people + in-person.'),
  ('ohio-preauction-v1', 7, 'sms', 24,
   '{{first_name}}, closing out your file on {{street_address}}. If you want to connect before {{auction_date}} I''m still available. {{agent_first_name}}',
   'Last touch. 24h window since auction is close. Named date creates finality.');

-- ── Touch 1 opener A/B/C experiment ──────────────────────────────────────────

insert into relay.experiments (id, name, description) values (
  'touch-1-opener-2026-q2',
  'Touch 1 Opener - Q2 2026',
  'Tests three opener variants. A: pure identity confirm (control). B: address-first. C: investigator title. 60/20/20 split.'
);

insert into relay.experiment_variants (id, experiment_id, name, weight, message_template, notes) values
  (
    'touch-1-opener-2026-q2-A',
    'touch-1-opener-2026-q2',
    'identity-confirm',
    60,
    'Hi, is this {{first_name}} {{last_name}} in {{county}} County?',
    'Control. Pure identity confirm. No context. Looks exactly like a personal text.'
  ),
  (
    'touch-1-opener-2026-q2-B',
    'touch-1-opener-2026-q2',
    'address-first',
    20,
    'Hi {{first_name}}, I have something time-sensitive about {{street_address}} in {{county}} County that I need to get to the right person. Is this {{last_name}}?',
    'Challenger. Leads with address. Tests whether specificity increases reply rate.'
  ),
  (
    'touch-1-opener-2026-q2-C',
    'touch-1-opener-2026-q2',
    'investigator',
    20,
    'Hi, is this {{first_name}} {{last_name}} in {{county}} County? I''m a local investigator in Ohio.',
    'Challenger. Adds investigator title. Tests whether authority signal increases reply rate.'
  );

-- Wire experiment to step 1 of all three sequences
update relay.sequence_steps
  set experiment_id = 'touch-1-opener-2026-q2'
  where step_number = 1
    and sequence_id in ('ohio-surplus-v1', 'ohio-preforeclosure-v1', 'ohio-preauction-v1');

-- ── pg_cron jobs ──────────────────────────────────────────────────────────────

select cron.schedule(
  'relay-dispatcher-every-15min',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/relay-dispatcher',
    headers := jsonb_build_object(
      'Content-Type',   'application/json',
      'x-relay-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'relay_secret' limit 1)
    ),
    body    := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'relay-auto-enroll-every-15min',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/relay-auto-enroll',
    headers := jsonb_build_object(
      'Content-Type',   'application/json',
      'x-relay-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'relay_secret' limit 1)
    ),
    body    := '{}'::jsonb
  );
  $$
);
