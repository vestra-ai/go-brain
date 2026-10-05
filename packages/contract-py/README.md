# go-contract (Python)

The Go contract for Python: a pydantic model for every request, response and event, plus request
signing and spend approvals. The guide is in `docs/guide` at the root of this repo.

```bash
pip install "go-contract @ git+ssh://git@github.com/vestra-ai/go-brain.git#subdirectory=packages/contract-py"
```

`go_contract/models.py` is generated from `packages/contract/openapi/go-server.json`
(`python scripts/gen_models.py`). Do not edit it by hand: change the zod schemas in
`packages/contract`, run `pnpm --filter @go/contract emit-openapi`, then regenerate.
