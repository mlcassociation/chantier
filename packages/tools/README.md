# @chantier/tools

The seven built-in tools of the [chantier](https://github.com/mlcassociation/chantier)
coding agent: bash, edit, glob, grep, read, webfetch, and write. Each returns
model-facing prose (not stack traces) and never executes a mutation without an
allow decision from the permission engine.

```ts
import { buildTools } from "@chantier/tools";
```

License: Apache-2.0.