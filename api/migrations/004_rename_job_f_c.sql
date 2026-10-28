-- Upgrade DBs created before file_count / values_per_file column names.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'f'
  ) THEN
    ALTER TABLE jobs RENAME COLUMN f TO file_count;
    ALTER TABLE jobs RENAME COLUMN c TO values_per_file;
  END IF;
END $$;
