-- Until PUT /fleet, seed W from WORKER_COUNT. See docs/code-map.md · LLD §13.
ALTER TABLE fleet ADD COLUMN set_by_api boolean NOT NULL DEFAULT false;
