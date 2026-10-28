CREATE TYPE job_status  AS ENUM ('GENERATING', 'REDUCING', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE task_kind   AS ENUM ('GENERATE', 'MERGE');
CREATE TYPE task_status AS ENUM ('CREATED', 'PUBLISHED', 'DONE', 'FAILED', 'CANCELLED');
CREATE TYPE item_kind   AS ENUM ('INPUT', 'PARTIAL');
CREATE TYPE item_state  AS ENUM ('READY', 'RESERVED', 'CONSUMED', 'DELETED');

CREATE TABLE jobs (
  id                       uuid PRIMARY KEY,
  file_count               integer NOT NULL CHECK (file_count BETWEEN 2 AND 99999),
  values_per_file          integer NOT NULL CHECK (values_per_file BETWEEN 2 AND 999999),
  status                   job_status NOT NULL DEFAULT 'GENERATING',
  seed                     bigint NOT NULL CHECK (seed >= 0),
  generated_files          integer NOT NULL DEFAULT 0,
  failure_reason           text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  generation_completed_at  timestamptz,
  finished_at              timestamptz,
  partials_cleaned_at      timestamptz
);

CREATE TABLE tasks (
  id            uuid PRIMARY KEY,
  job_id        uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind          task_kind NOT NULL,
  status        task_status NOT NULL DEFAULT 'CREATED',
  attempt       smallint NOT NULL DEFAULT 1,
  level         smallint NOT NULL,
  file_start    integer,
  file_count    smallint,
  input_count   integer,
  is_final      boolean NOT NULL DEFAULT false,
  worker_id     text,
  duration_ms   integer,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  completed_at  timestamptz
);
CREATE INDEX tasks_outbox   ON tasks (created_at) WHERE status = 'CREATED';
CREATE INDEX tasks_job_open ON tasks (job_id, kind) WHERE status IN ('CREATED', 'PUBLISHED');

CREATE TABLE items (
  id           uuid PRIMARY KEY,
  job_id       uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind         item_kind NOT NULL,
  state        item_state NOT NULL DEFAULT 'READY',
  count        integer NOT NULL,
  level        smallint NOT NULL,
  path         text NOT NULL,
  produced_by  uuid,
  reserved_by  uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX items_pool     ON items (job_id, created_at, id) WHERE state = 'READY';
CREATE INDEX items_reserved ON items (reserved_by) WHERE state = 'RESERVED';
