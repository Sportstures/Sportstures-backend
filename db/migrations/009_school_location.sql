-- Where a school is. Both are optional: schools are created from signup by name only, and
-- province/town are filled in at signup when given, or later by an admin or the school's coach.
-- Province values are the 9 South African provinces, spelled as the website shows them.

ALTER TABLE schools ADD COLUMN IF NOT EXISTS province VARCHAR(30);
ALTER TABLE schools ADD COLUMN IF NOT EXISTS town VARCHAR(100);

ALTER TABLE schools DROP CONSTRAINT IF EXISTS schools_province_check;
ALTER TABLE schools ADD CONSTRAINT schools_province_check CHECK (
  province IS NULL OR province IN (
    'Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo',
    'Mpumalanga', 'North West', 'Northern Cape', 'Western Cape'
  )
);

CREATE INDEX IF NOT EXISTS idx_schools_province ON schools(province);
