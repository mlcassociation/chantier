# @chantier/permissions

Deny-first permission engine for the [chantier](https://github.com/mlcassociation/chantier)
coding agent. Rules are evaluated in a fixed ladder (deny wins over allow; allow
never punches through a deny), every mutation flows through an approval sink,
and remembered grants live in a `RememberingEngine`.

```ts
import { createPermissionEngine, createRememberingEngine } from "@chantier/permissions";
```

License: Apache-2.0.