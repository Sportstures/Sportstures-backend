-- Migration 012: profile photos. The image itself is stored on Cloudinary; the database keeps its
-- public URL (sent to the apps) and its Cloudinary public id (needed to delete it).
-- Safe to run more than once. Requires migrations 001 to 011.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_public_id VARCHAR(255);
