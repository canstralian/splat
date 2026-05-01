-- 1. Tighten company_settings SELECT: only owner
DROP POLICY IF EXISTS "Authenticated can view company settings" ON public.company_settings;
CREATE POLICY "Owner can view company settings" ON public.company_settings
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- 2. Tighten invitations SELECT: only inviter or admins
DROP POLICY IF EXISTS "Authenticated can view invitations" ON public.invitations;
CREATE POLICY "Inviter or admin can view invitations" ON public.invitations
  FOR SELECT TO authenticated
  USING (auth.uid() = invited_by OR public.has_role(auth.uid(), 'admin'));

-- 3. Tighten user_roles: drop broad SELECT, keep own + admin
DROP POLICY IF EXISTS "Authenticated can view all roles" ON public.user_roles;

-- 4. Create get_team_members() security definer function
CREATE OR REPLACE FUNCTION public.get_team_members()
RETURNS TABLE (
  user_id uuid,
  full_name text,
  job_title text,
  avatar_url text,
  role text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.user_id,
    p.full_name,
    p.job_title,
    p.avatar_url,
    COALESCE(ur.role::text, 'user') AS role
  FROM public.profiles p
  LEFT JOIN public.user_roles ur ON ur.user_id = p.user_id
$$;