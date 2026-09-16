# @chantier/providers

Model provider adapters for the [chantier](https://github.com/mlcassociation/chantier)
coding agent. Ships an Anthropic adapter and an OpenAI-compatible adapter
(Ollama, vLLM, llama.cpp, LM Studio, ...). The `ModelAdapter` interface in
`@chantier/core` is the only seam a provider SDK touches.

```ts
import { resolveAdapter } from "@chantier/providers";
```

License: Apache-2.0.