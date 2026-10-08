"""One model for any card, for a body that can be any card kind (PUT /cards/{card_id})."""

from typing import Annotated

from pydantic import Field, RootModel

from . import models

AnyCard = Annotated[
    models.VoteCard
    | models.MandateCard
    | models.TicketCard
    | models.ExpenseCard
    | models.SettleUpCard
    | models.DayCard
    | models.PlanCard
    | models.BudgetCard
    | models.OptionsCard
    | models.WorkingCard
    | models.CallCard
    | models.PayCard
    | models.NoticeCard
    | models.ChecklistCard,
    Field(discriminator="kind"),
]


class Card(RootModel[AnyCard]):
    """Any of the 14 card kinds (1.1 added checklist). `Card.model_validate_json(body).root` is the specific card."""
