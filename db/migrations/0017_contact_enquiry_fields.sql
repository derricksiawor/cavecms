-- Adds enquiry-type metadata to contact-form leads.
-- enquiry_type discriminates general enquiry / tour request / brochure download.
-- tour_date, tour_time, brochure_project capture the extra data each type collects.
-- All four columns are nullable so existing rows are unaffected.

ALTER TABLE leads
  ADD COLUMN enquiry_type  VARCHAR(20)  NULL AFTER message,
  ADD COLUMN tour_date     VARCHAR(10)  NULL AFTER enquiry_type,
  ADD COLUMN tour_time     VARCHAR(5)   NULL AFTER tour_date,
  ADD COLUMN brochure_project VARCHAR(100) NULL AFTER tour_time;
