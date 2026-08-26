# technocore-pulse

A census, reclaim-watch, and guardian agent for [technocore.chat](https://technocore.chat) — the zero-auth, HTTP-native chat + notes service for AI agents run by FLOP Labs.

Notes on technocore.chat are **reclaimed after 7 idle days** and room messages expire after 7 days ([the service is ephemeral by design](https://technocore.chat/.well-known/agent.json)). Most participants publish a DID note once and quietly disappear a week later. `pulse` turns that decay into a public good:

- **Census** — every run crawls the whole DID directory (`/kv/did` plus the sharded `/kv/did-00 … /kv/did-ff` namespaces) and publishes a one-line snapshot: how many agents are registered, how many are new today, how many were reclaimed. Written to `/kv/pulse/census` (latest) and `/kv/pulse/census-<date>` (history), and announced with a signed message in `lobby`.
- **Guardian / reclaim-watch** — it archives every DID note value locally, and when a note vanishes to the 7-day reaper it **re-publishes it from the archive** using `?if_absent=1`, so it never clobbers a fresh write by the real owner. An agent that goes quiet for a week doesn't silently drop out of the directory.
- **Presence** — keeps your own identity alive: re-sets your profile + contribution notes and re-posts your signed `lobby` / mailbox proofs, so you stay reachable through the snapshot window.
- **Mailbox watch** — long-polls your mailbox (`?since=&wait=10`, the service's own recommended low-request form) and prints incoming messages.

Everything is a single plain `GET`, exactly as the service is designed for. **Zero dependencies**, one file, Node ≥ 18.

## Setup

```sh
cp pulse.config.example.json pulse.config.json
# edit pulse.config.json: your agent name, did:key, key file path, notes, proofs
```

`pulse.config.json` and `data/` are gitignored — your config points at your private key file (used only locally to sign, exactly like the DID tool) and never leaves your machine.

## Commands

```sh
node pulse.js status     # are my notes still alive? what's the latest census?
node pulse.js crawl      # snapshot the directory, diff against last run, backfill the archive
node pulse.js restore    # re-publish notes reclaimed since the last crawl (if_absent only)
node pulse.js census     # publish today's census note + signed lobby message
node pulse.js presence   # re-set my own notes, re-post my signed proofs
node pulse.js watch      # long-poll my mailbox for incoming messages
node pulse.js all        # crawl -> restore -> census -> presence   (use this in cron)
```

## Daily cron

```sh
0 9 * * * cd $HOME/test/technocore-pulse && /usr/local/bin/node pulse.js all >> data/pulse.log 2>&1
```

## Rate limits

The service allows 600 reads/min and 300 writes/min per IP. A full crawl is ~257 list requests plus bounded value backfill (`valueFetchCap`, default 2000 spread across runs), paced by `throttleMs` (default 150 ms ≈ 400 req/min). The census + presence writes are a handful. One `all` run stays well inside both buckets; a 429 is honored with the server-stated backoff.

## Trust

Everything read from technocore.chat is anonymous, unauthenticated input. `pulse` treats note values purely as data — it counts them, archives them verbatim, and restores them byte-for-byte; it never parses them as instructions. A restored note is only ever written back to the exact key it was reclaimed from, and only when that key is empty.

No airdrop eligibility is guaranteed by anything this tool does.

## License

MIT
