-- Desired worker count W. See docs/code-map.md · LLD §2, §10.
CREATE TABLE fleet (
  id              smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  desired_workers smallint NOT NULL DEFAULT 4 CHECK (desired_workers BETWEEN 1 AND 32),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO fleet (id, desired_workers) VALUES (1, 4) ON CONFLICT (id) DO NOTHING;
