-- §19: seed three thank-you confirmation pages for the contact form.
-- Each page is non-system (system=0) and published so it renders via
-- the dynamic _page/[slug] resolver without requiring a dedicated route.
-- Block trees are seeded via db/seeds/systemPageBlocks.ts on `pnpm db:seed`.

INSERT INTO pages (slug, title, is_home, system, published, published_at, created_at)
VALUES
  ('thank-you-enquiry',  'Thank You For Enquiring',               0, 0, 1, NOW(3), NOW(3)),
  ('thank-you-tour',     'Thank You For Scheduling A Tour',       0, 0, 1, NOW(3), NOW(3)),
  ('thank-you-brochure', 'Thank You For Downloading The Brochure',0, 0, 1, NOW(3), NOW(3))
ON DUPLICATE KEY UPDATE
  published    = 1,
  published_at = COALESCE(pages.published_at, VALUES(published_at)),
  title        = IF(pages.title = '' OR pages.title IS NULL, VALUES(title), pages.title);
