-- 1. Length CHECK constraints (server-side enforcement)
ALTER TABLE public.bugs
  ADD CONSTRAINT bugs_title_length CHECK (char_length(title) <= 200),
  ADD CONSTRAINT bugs_description_length CHECK (char_length(description) <= 5000),
  ADD CONSTRAINT bugs_steps_length CHECK (steps_to_reproduce IS NULL OR char_length(steps_to_reproduce) <= 5000),
  ADD CONSTRAINT bugs_expected_length CHECK (expected_behavior IS NULL OR char_length(expected_behavior) <= 2000),
  ADD CONSTRAINT bugs_actual_length CHECK (actual_behavior IS NULL OR char_length(actual_behavior) <= 2000),
  ADD CONSTRAINT bugs_environment_length CHECK (environment IS NULL OR char_length(environment) <= 200);

ALTER TABLE public.comments
  ADD CONSTRAINT comments_content_length CHECK (char_length(content) <= 2000);

-- 2. Allow company settings owners to delete their own row
-- (Already exists per current schema dump — recreate idempotently)
DROP POLICY IF EXISTS "Owner can delete company settings" ON public.company_settings;
CREATE POLICY "Owner can delete company settings"
  ON public.company_settings FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- 3. Tighten invitation creation: non-admins may only invite role = 'user'
DROP POLICY IF EXISTS "Role-scoped invitation creation" ON public.invitations;
CREATE POLICY "Role-scoped invitation creation"
  ON public.invitations FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = invited_by
    AND (
      role = 'user'::app_role
      OR has_role(auth.uid(), 'admin'::app_role)
    )
  );