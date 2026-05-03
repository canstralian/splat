-- Splat rebrand: tracking ID prefix, new severity/status enums, add category

-- 1. Tracking ID prefix BUG- -> SPL-
CREATE OR REPLACE FUNCTION public.generate_tracking_id()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.tracking_id = 'SPL-' || LPAD(nextval('public.bug_tracking_seq')::TEXT, 5, '0');
  RETURN NEW;
END;
$$;

UPDATE public.bugs
SET tracking_id = 'SPL-' || SUBSTRING(tracking_id FROM 5)
WHERE tracking_id LIKE 'BUG-%';

ALTER TABLE public.bugs ALTER COLUMN tracking_id SET DEFAULT 'SPL-00000';

-- 2. New severity enum: blocker, major, minor, polish
CREATE TYPE public.bug_severity_new AS ENUM ('blocker', 'major', 'minor', 'polish');

ALTER TABLE public.bugs
  ALTER COLUMN severity DROP DEFAULT,
  ALTER COLUMN severity TYPE public.bug_severity_new USING (
    CASE severity::text
      WHEN 'critical' THEN 'blocker'
      WHEN 'high' THEN 'major'
      WHEN 'medium' THEN 'minor'
      WHEN 'low' THEN 'polish'
    END::public.bug_severity_new
  ),
  ALTER COLUMN severity SET DEFAULT 'minor';

DROP TYPE public.bug_severity;
ALTER TYPE public.bug_severity_new RENAME TO bug_severity;

-- 3. New status enum: backlog, in_progress, in_review, shipped, wont_fix
CREATE TYPE public.bug_status_new AS ENUM ('backlog', 'in_progress', 'in_review', 'shipped', 'wont_fix');

ALTER TABLE public.bugs
  ALTER COLUMN status DROP DEFAULT,
  ALTER COLUMN status TYPE public.bug_status_new USING (
    CASE status::text
      WHEN 'new' THEN 'backlog'
      WHEN 'assigned' THEN 'backlog'
      WHEN 'in_progress' THEN 'in_progress'
      WHEN 'testing' THEN 'in_review'
      WHEN 'resolved' THEN 'shipped'
      WHEN 'closed' THEN 'wont_fix'
    END::public.bug_status_new
  ),
  ALTER COLUMN status SET DEFAULT 'backlog';

DROP TYPE public.bug_status;
ALTER TYPE public.bug_status_new RENAME TO bug_status;

-- 4. Add category enum + column
CREATE TYPE public.bug_category AS ENUM ('ui', 'logic', 'performance', 'infra', 'content');

ALTER TABLE public.bugs
  ADD COLUMN category public.bug_category NOT NULL DEFAULT 'logic';