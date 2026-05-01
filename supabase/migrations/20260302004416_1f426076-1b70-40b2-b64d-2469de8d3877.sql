
-- Step 1: Enums
CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');
CREATE TYPE public.bug_severity AS ENUM ('critical', 'high', 'medium', 'low');
CREATE TYPE public.bug_status AS ENUM ('new', 'assigned', 'in_progress', 'testing', 'resolved', 'closed');

-- Step 2: Profiles table
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,
  job_title TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Profiles viewable by authenticated users" ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own profile" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

-- Step 3: User roles table
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL DEFAULT 'user',
  UNIQUE (user_id, role)
);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own roles" ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- Step 4: has_role function (MUST come before policies that use it)
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role
  )
$$;

-- Step 5: Admin policy on user_roles (now has_role exists)
CREATE POLICY "Admins can manage roles" ON public.user_roles FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- Step 6: Projects table
CREATE TABLE public.projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Projects viewable by authenticated" ON public.projects FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can manage projects" ON public.projects FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- Step 7: Bugs table
CREATE TABLE public.bugs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  steps_to_reproduce TEXT DEFAULT '',
  expected_behavior TEXT DEFAULT '',
  actual_behavior TEXT DEFAULT '',
  severity public.bug_severity NOT NULL DEFAULT 'medium',
  status public.bug_status NOT NULL DEFAULT 'new',
  environment TEXT DEFAULT '',
  project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  reporter_id UUID NOT NULL REFERENCES auth.users(id),
  assignee_id UUID REFERENCES auth.users(id),
  sla_deadline TIMESTAMPTZ,
  tracking_id TEXT NOT NULL DEFAULT 'BUG-00000',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.bugs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Bugs viewable by authenticated" ON public.bugs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can create bugs" ON public.bugs FOR INSERT TO authenticated WITH CHECK (auth.uid() = reporter_id);
CREATE POLICY "Reporter or assignee can update bugs" ON public.bugs FOR UPDATE TO authenticated USING (auth.uid() = reporter_id OR auth.uid() = assignee_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins can delete bugs" ON public.bugs FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- Step 8: Comments
CREATE TABLE public.comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bug_id UUID NOT NULL REFERENCES public.bugs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Comments viewable by authenticated" ON public.comments FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can create comments" ON public.comments FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own comments" ON public.comments FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own comments" ON public.comments FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Step 9: Activity log
CREATE TABLE public.activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bug_id UUID NOT NULL REFERENCES public.bugs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  action TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Activity viewable by authenticated" ON public.activity_log FOR SELECT TO authenticated USING (true);
CREATE POLICY "System can insert activity" ON public.activity_log FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

-- Step 10: Attachments
CREATE TABLE public.attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bug_id UUID NOT NULL REFERENCES public.bugs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size BIGINT DEFAULT 0,
  mime_type TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Attachments viewable by authenticated" ON public.attachments FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can upload attachments" ON public.attachments FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own attachments" ON public.attachments FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Step 11: Storage bucket
INSERT INTO storage.buckets (id, name, public) VALUES ('bug-attachments', 'bug-attachments', true);
CREATE POLICY "Authenticated can upload bug attachments" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'bug-attachments');
CREATE POLICY "Bug attachments publicly readable" ON storage.objects FOR SELECT USING (bucket_id = 'bug-attachments');
CREATE POLICY "Users can delete own bug attachments" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'bug-attachments' AND auth.uid()::text = (storage.foldername(name))[1]);

-- Step 12: updated_at trigger function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_projects_updated_at BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_bugs_updated_at BEFORE UPDATE ON public.bugs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_comments_updated_at BEFORE UPDATE ON public.comments FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Step 13: Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (user_id, full_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', ''));
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'user');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Step 14: Indexes
CREATE INDEX idx_bugs_status ON public.bugs(status);
CREATE INDEX idx_bugs_severity ON public.bugs(severity);
CREATE INDEX idx_bugs_assignee ON public.bugs(assignee_id);
CREATE INDEX idx_bugs_reporter ON public.bugs(reporter_id);
CREATE INDEX idx_bugs_project ON public.bugs(project_id);
CREATE INDEX idx_comments_bug ON public.comments(bug_id);
CREATE INDEX idx_activity_bug ON public.activity_log(bug_id);
CREATE INDEX idx_attachments_bug ON public.attachments(bug_id);

-- Step 15: Tracking ID sequence
CREATE SEQUENCE public.bug_tracking_seq START 1;

CREATE OR REPLACE FUNCTION public.generate_tracking_id()
RETURNS TRIGGER AS $$
BEGIN
  NEW.tracking_id = 'BUG-' || LPAD(nextval('public.bug_tracking_seq')::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER set_bug_tracking_id
  BEFORE INSERT ON public.bugs
  FOR EACH ROW EXECUTE FUNCTION public.generate_tracking_id();
