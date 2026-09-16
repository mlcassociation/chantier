# @chantier/core

Agent loop, session store, and the `ModelAdapter` seam for the
[chantier](https://github.com/mlcassociation/chantier) coding agent. Sessions
are plain JSONL under `~/.chantier/sessions/`; compaction is a derived view
over that append-only log, never a rewrite of it.

```ts
import { runAgent, createSessionStore } from "@chantier/core";
```

License: Apache-2.0.