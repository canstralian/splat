CREATE POLICY "Owner can delete company settings"
ON public.company_settings FOR DELETE
TO authenticated
USING (auth.uid() = user_id);