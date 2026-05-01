
-- Make bug-attachments bucket private
UPDATE storage.buckets SET public = false WHERE id = 'bug-attachments';

-- Drop the public SELECT policy
DROP POLICY IF EXISTS "Bug attachments publicly readable" ON storage.objects;

-- Create authenticated-only SELECT policy
CREATE POLICY "Authenticated can view bug attachments"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'bug-attachments');
