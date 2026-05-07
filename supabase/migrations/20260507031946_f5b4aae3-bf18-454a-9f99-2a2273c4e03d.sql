
CREATE TABLE public.company_settings_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_settings_id uuid,
  user_id uuid NOT NULL,
  actor_id uuid,
  action text NOT NULL CHECK (action IN ('update','delete')),
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.company_settings_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view company settings audit"
ON public.company_settings_audit FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Owner can view own company settings audit"
ON public.company_settings_audit FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE INDEX idx_company_settings_audit_user ON public.company_settings_audit(user_id);
CREATE INDEX idx_company_settings_audit_created ON public.company_settings_audit(created_at DESC);

CREATE OR REPLACE FUNCTION public.log_company_settings_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    INSERT INTO public.company_settings_audit
      (company_settings_id, user_id, actor_id, action, old_data, new_data)
    VALUES
      (OLD.id, OLD.user_id, auth.uid(), 'update', to_jsonb(OLD), to_jsonb(NEW));
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.company_settings_audit
      (company_settings_id, user_id, actor_id, action, old_data, new_data)
    VALUES
      (OLD.id, OLD.user_id, auth.uid(), 'delete', to_jsonb(OLD), NULL);
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.log_company_settings_change() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_company_settings_audit_update
AFTER UPDATE ON public.company_settings
FOR EACH ROW EXECUTE FUNCTION public.log_company_settings_change();

CREATE TRIGGER trg_company_settings_audit_delete
AFTER DELETE ON public.company_settings
FOR EACH ROW EXECUTE FUNCTION public.log_company_settings_change();
