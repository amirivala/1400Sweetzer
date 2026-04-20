-- 00010_seed_providers.sql
-- Seed the providers table from the owner-only vendor list.
-- Idempotent: skips any row whose (name, phone) pair already exists.

do $$
declare
  owner uuid;
begin
  select id into owner
    from profiles
   where role = 'admin' and status = 'approved'
   order by created_at asc
   limit 1;

  if owner is null then
    raise exception 'cannot seed providers: no approved admin profile exists yet';
  end if;

  insert into providers (name, category, phone, email, notes, created_by)
  select v.name, v.category::provider_category, v.phone, v.email, v.notes, owner
  from (values
    ('Johnson Controls',
     'HVAC',
     '866-819-0230',
     null,
     'Unit HVAC service. Call to schedule; HOA is billed first, then the homeowner reimburses the HOA.'),

    ('Pete the Plumber',
     'Plumbing',
     '323-654-5404',
     null,
     'Has worked in the building for years. Plumbing only — does not service HVAC.'),

    ('Eric Hassett',
     'Electrical',
     '310-650-5079',
     null,
     'Smaller electrical jobs. Cell number.'),

    ('Nathan Clarken — Madison Electric',
     'Electrical',
     '310-514-6114',
     null,
     'Madison Electric. For larger electrical jobs.'),

    ('Emerson Locks',
     'Locksmith',
     '310-652-7224',
     null,
     'Cuts MEDECO keys for the building.'),

    ('Julian Ejaclon',
     'Cleaning',
     '323-252-8809',
     null,
     'Hallway carpet cleaning. Cell number.'),

    ('Van Nuys Awnings',
     'Other',
     '818-782-8607',
     null,
     'Awnings.'),

    ('Edy Castillo',
     'Other',
     '323-674-5417',
     null,
     'General contracting — plaster, tile, and paint.'),

    ('Israel Aguilar',
     'Other',
     '323-351-5746',
     null,
     'Interior painting, smaller jobs.'),

    ('Ceasar — Faux Finish',
     'Other',
     '818-966-8288',
     null,
     'Faux-finish refinisher for the doors to individual units.'),

    ('Wendy Weber — HOA Insurance Specialist',
     'Other',
     '800-535-3635',
     'wendy@hoaspecialist.com',
     'HOA insurance: general liability, fire, and earthquake. Contact for insurance certificates.')
  ) as v(name, category, phone, email, notes)
  where not exists (
    select 1 from providers p
     where p.name = v.name and p.phone = v.phone
  );
end $$;
