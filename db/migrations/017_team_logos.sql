-- A coach can upload a logo for their team. The image lives on Cloudinary; we keep its address and id.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS logo_public_id VARCHAR(255);
