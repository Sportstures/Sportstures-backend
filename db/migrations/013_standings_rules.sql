-- Migration 013: per-competition table rules (points and tiebreakers).
-- Safe to run more than once. Requires migrations 001 to 012.
--
-- Every competition decides its own table. Leave the columns alone and a competition uses the
-- standard rules: win 3, draw 1, loss 0, then goal/points difference, then scored, then head-to-head.
--   points_win / points_draw / points_loss  what a result is worth (for example netball: 2 / 1 / 0)
--   tiebreakers  the order used when teams are level on points. NULL means the standard order.
--                Allowed: difference, for, against, wins, head_to_head
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS points_win SMALLINT NOT NULL DEFAULT 3;
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS points_draw SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS points_loss SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS tiebreakers TEXT[];

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'competitions_points_check') THEN
    ALTER TABLE competitions ADD CONSTRAINT competitions_points_check
      CHECK (points_win BETWEEN 0 AND 10 AND points_draw BETWEEN 0 AND 10 AND points_loss BETWEEN 0 AND 10);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'competitions_tiebreakers_check') THEN
    ALTER TABLE competitions ADD CONSTRAINT competitions_tiebreakers_check
      CHECK (tiebreakers IS NULL OR (
        cardinality(tiebreakers) BETWEEN 1 AND 5
        AND tiebreakers <@ ARRAY['difference', 'for', 'against', 'wins', 'head_to_head']::text[]));
  END IF;
END $$;
