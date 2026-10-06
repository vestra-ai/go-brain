# go-contract (Python)

The Go contract for Python: a pydantic model for every request, response and event, plus request
signing and spend approvals. The guide is in `docs/guide` at the root of this repo.

```bash
pip install "go-contract @ git+ssh://git@github.com/vestra-ai/go-brain.git#subdirectory=packages/contract-py"
```

```python
from go_contract import Card, models, sign_request, verify_request

event = models.Event.model_validate_json(raw_body).root   # a MessageCreated, a DecisionClosed, ...
card = Card.model_validate_json(raw_card).root            # a TicketCard, a CallCard, ...
```

The models check the shape of every body and most limits. A few limits are only in the TypeScript
contract (lengths and link rules on fields that may be empty, and a message needing text or a card);
Go checks those on its side.

`go_contract/models.py` is generated from `packages/contract/openapi/go.json`
(`python scripts/gen_models.py`). Do not edit it by hand: change the zod schemas in
`packages/contract`, run `pnpm --filter @go/contract emit-openapi`, then regenerate.
