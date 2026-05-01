

# Security Hardening Plan

## Security Scan Results
The scan found 10 issues. For a team bug tracker, most broad SELECT policies are intentional (team members need to see bugs, comments, profiles, activity). The real fixes needed are:

## Changes

### 1. Database Migration — Tighten RLS Policies
- **company_settings SELECT**: Change from `true` to `auth.uid() = user_id` (only owner sees their company settings)
- **invitations SELECT**: Change from `true` to `auth.uid() = invited_by OR has_role(auth.uid(), 'admin')` (only inviter/admins see invitations)
- **user_roles**: Drop the redundant "Authenticated can view all roles" policy. Keep "Users can view own roles" and "Admins can manage roles". Add a new SELECT policy for admins: `has_role(auth.uid(), 'admin')`. For the Team tab, use the existing `has_role` security definer function pattern instead of direct table access.
- **Enable leaked password protection** via auth config

### 2. Settings.tsx — Team Tab Fix
After tightening `user_roles` and `profiles` visibility, the Team tab needs to fetch team members via a security definer function that returns profiles with roles (so non-admins can see team members without direct table access).

### 3. New Security Definer Function
Create `get_team_members()` — returns user_id, full_name, job_title, avatar_url, and role for all users. Called by the Team tab instead of directly querying profiles + user_roles.

## Files Modified
- New SQL migration: drop/recreate policies for company_settings, invitations, user_roles; create `get_team_members()` function
- `src/pages/Settings.tsx` — update Team tab to call the new function
- Auth config: enable leaked password protection

