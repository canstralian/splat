-- Fix user_roles RLS so team role visibility works while keeping role mutation admin-only.
--
-- Context:
-- - The base migration created a self-only SELECT policy on public.user_roles.
-- - Later hardening removed the broad SELECT policy used by team membership screens.
-- - Admin mutation was also defined with a broad FOR ALL policy and no explicit WITH CHECK.
--
-- This migration makes SELECT team-visible to authenticated users and splits writes by verb
-- so INSERT/UPDATE rows are checked explicitly.

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own roles" ON public.user_roles;
DROP POLICY IF EXISTS "Authenticated can view all roles" ON public.user_roles;
DROP POLICY IF EXISTS "Allow authenticated users to read roles" ON public.user_roles;
DROP POLICY IF EXISTS "Admins can manage roles" ON public.user_roles;
DROP POLICY IF EXISTS "Allow admins to insert roles" ON public.user_roles;
DROP POLICY IF EXISTS "Allow admins to update roles" ON public.user_roles;
DROP POLICY IF EXISTS "Allow admins to delete roles" ON public.user_roles;

CREATE POLICY "Allow authenticated users to read roles"
ON public.user_roles
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Allow admins to insert roles"
ON public.user_roles
FOR INSERT
TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY "Allow admins to update roles"
ON public.user_roles
FOR UPDATE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY "Allow admins to delete roles"
ON public.user_roles
FOR DELETE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::public.app_role));

-- Keep has_role callable only through policies/functions, not directly by clients.
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon, authenticated;
