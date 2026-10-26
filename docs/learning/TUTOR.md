# Tutor prompts (paste into Agent chat)

Attach files with `@` as listed. Ask the agent to **cite code** with line ranges and to **quiz you** at the end.

## Start a module (from Academy canvas)

```
I'm on Dismean Academy module "<MODULE_TITLE>" (id: <MODULE_ID>).
Teach it in order: concept → LLD section → walk through the listed files with code citations.
Then give me 5 oral-exam questions (no answers until I reply "grade me").
@docs/lld.md @docs/code-map.md
<file paths from the module>
```

## Deep dive one file

```
Deep-dive @<path> for dismean.
1. One-paragraph purpose tied to LLD section.
2. Call graph: who calls this, what it calls (with citations).
3. Three invariants this file must uphold (from AGENTS.md / ITD).
4. What breaks if we change X (name one realistic change).
5. Point me to the best test(s) that lock behaviour.
```

## Trace one GENERATE task

```
Trace one GENERATE task end-to-end for job :id (or hypothetical).
States in Postgres, AMQP messages (queue names), worker code path, coordinator transaction, ack timing.
Cite code at each hop. @api/src/relay/index.ts @api/src/coordinator @worker/src/dismean_worker/worker.py @infra/rabbitmq/definitions.json
```

## Trace one MERGE task

```
Same as GENERATE but MERGE: pool items, partial file paths from paths.ts only on API side, worker reads paths from message.
@docs/diagrams/reduction-walkthrough.md @api/src/scheduler @api/src/paths.ts
```

## "Where is X?" drill

```
Quiz mode: ask me 10 "where is X implemented?" questions about dismean (random mix API, worker, infra, UI).
Wait for my answers, then grade and cite the correct file:line for each miss.
Use @docs/code-map.md only after grading.
```

## After `./scripts/verify-all.sh`

```
I ran verify-all. Explain what each major stage tests and which source files it exercises. Map failures I might see to components.
@scripts/verify-all.sh @docs/design-doc.md
```
