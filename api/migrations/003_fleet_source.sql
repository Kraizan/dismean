-- Until an operator sets W through PUT /fleet, the API seeds it from WORKER_COUNT at startup.
ALTER TABLE fleet ADD COLUMN set_by_api boolean NOT NULL DEFAULT false;
