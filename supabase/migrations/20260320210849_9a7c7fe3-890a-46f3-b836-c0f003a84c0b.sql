
-- Recreate get_team_members with auth check using plpgsql
CREATE OR REPLACE FUNCTION public.get_team_members()
 RETURNS TABLE(user_id uuid, full_name text, job_title text, avatar_url text, role text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
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

-- Revoke anonymous access
REVOKE EXECUTE ON FUNCTION public.get_team_members() FROM anon;
