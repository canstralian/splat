
-- 1. Restrict user_roles INSERT/UPDATE/DELETE to admins only (explicit per-command policies)
DROP POLICY IF EXISTS "Admins can manage roles" ON public.user_roles;

CREATE POLICY "Admins can insert roles" ON public.user_roles
  FOR INSERT TO authenticated
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can update roles" ON public.user_roles
  FOR UPDATE TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can delete roles" ON public.user_roles
  FOR DELETE TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

-- 2. Role-scoped invitation creation: only admins can invite admin/moderator roles
DROP POLICY IF EXISTS "Authenticated can create invitations" ON public.invitations;

CREATE POLICY "Role-scoped invitation creation" ON public.invitations
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = invited_by
    AND (role = 'user'::app_role OR has_role(auth.uid(), 'admin'::app_role))
  );

-- 3. Scope bug-attachments uploads to uploader's own folder
DROP POLICY IF EXISTS "Authenticated can upload bug attachments" ON storage.objects;

CREATE POLICY "Authenticated can upload bug attachments"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'bug-attachments'
    AND (storage.foldername(name))[1] = (auth.uid())::text
  );

-- 4. Restrict updates on bug-attachments to file owners
CREATE POLICY "Users can update own bug attachments"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'bug-attachments'
    AND (storage.foldername(name))[1] = (auth.uid())::text
  )
  WITH CHECK (
    bucket_id = 'bug-attachments'
    AND (storage.foldername(name))[1] = (auth.uid())::text
  );
