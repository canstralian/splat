-- Ensure the Settings Team tab can call get_team_members() after earlier EXECUTE revokes.

GRANT EXECUTE ON FUNCTION public.get_team_members() TO authenticated;
