-- 1. Avatars bucket: replace broad SELECT with owner-folder-scoped listing
DROP POLICY IF EXISTS "Authenticated can view avatars" ON storage.objects;

CREATE POLICY "Users can list own avatar folder"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'avatars'
  AND (storage.foldername(name))[1] = (auth.uid())::text
);

-- 2. Convert get_team_members to SECURITY INVOKER so RLS applies to caller
CREATE OR REPLACE FUNCTION public.get_team_members()
RETURNS TABLE(user_id uuid, full_name text, job_title text, avatar_url text, role text)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN QUERY
  SELECT
    p.user_id,
    p.full_name,
    p.job_title,
    p.avatar_url,
    COALESCE(ur.role::text, 'user') AS role
  FROM public.profiles p
  LEFT JOIN public.user_roles ur ON ur.user_id = p.user_id;
END;
$function$;

-- 3. Allow authenticated users to view all roles (intentional team visibility)
DROP POLICY IF EXISTS "Authenticated can view all roles" ON public.user_roles;
CREATE POLICY "Authenticated can view all roles"
ON public.user_roles
FOR SELECT
TO authenticated
USING (true);