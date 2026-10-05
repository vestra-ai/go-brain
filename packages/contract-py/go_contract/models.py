# Generated from packages/contract/openapi/go-brain.json by scripts/gen_models.py. Do not edit.

from __future__ import annotations

from datetime import date as date_aliased
from typing import Annotated, Any, Literal

from pydantic import AwareDatetime, BaseModel, Field, RootModel


class PersonActor(BaseModel):
    kind: Literal["person"]
    person_id: Annotated[str, Field(max_length=64, min_length=1)]


class GoActor(BaseModel):
    kind: Literal["go"]


class SystemActor(BaseModel):
    kind: Literal["system"]


class Place(BaseModel):
    name: Annotated[str, Field(max_length=120, min_length=1)]
    place_id: str | None = None
    address: str | None = None
    lat: float | None = None
    lng: float | None = None
    photo_url: str | None = None


class Origin(BaseModel):
    name: Annotated[str, Field(max_length=80, min_length=1)]
    code: str | None = None


class Destination(BaseModel):
    name: Annotated[str, Field(max_length=80, min_length=1)]
    code: str | None = None


class Journey(BaseModel):
    mode: Literal["flight", "train", "bus", "cab"]
    origin: Origin
    destination: Destination
    depart_at: AwareDatetime
    arrive_at: AwareDatetime
    carrier_name: str | None = None
    carrier_code: str | None = None
    number: str | None = None
    logo_url: str | None = None
    stops: int | None = None


class Person(BaseModel):
    person_id: Annotated[str, Field(max_length=64, min_length=1)]
    name: Annotated[str, Field(max_length=80, min_length=1)]
    photo_url: str | None = None
    role: Literal["organizer", "member"]
    joined_at: AwareDatetime
    from_city: str | None = None
    earliest_leave: str | None = None
    know: Annotated[list[str], Field(max_length=20)]
    has_upi: bool
    go_paused: bool


class BudgetBand(BaseModel):
    min_minor: Annotated[int, Field(ge=0)]
    max_minor: int | None = None
    currency: Annotated[str, Field(pattern="^[A-Z]{3}$")]


class BudgetSummary(BaseModel):
    lowest: BudgetBand | None = None
    answered: Annotated[int, Field(ge=0)]
    of: Annotated[int, Field(ge=0)]


class CardAction(BaseModel):
    action_id: Annotated[str, Field(pattern="^[a-z][a-z_]{0,31}$")]
    label: Annotated[str, Field(max_length=24, min_length=1)]
    style: Literal["primary", "secondary"]
    only_for_person_ids: list[str] | None = None
    per_option: bool | None = None


class VoteCard(BaseModel):
    """
    A vote. The server draws the options, the tally and the vote buttons.
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: list[str] | None = None
    kind: Literal["vote"]
    decision_id: Annotated[str, Field(max_length=64, min_length=1)]


class MandateCard(BaseModel):
    """
    Ready to book: what the group allowed (the choice, the cap, refundable or not, who pays). The server shows "Yes, book it" and "Not now" to the payer only.
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: list[str] | None = None
    kind: Literal["mandate"]
    decision_id: Annotated[str, Field(max_length=64, min_length=1)]


class TicketCard(BaseModel):
    """
    A booking, drawn as a ticket (boarding pass, stay pass, table).
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: list[str] | None = None
    kind: Literal["ticket"]
    booking_id: Annotated[str, Field(max_length=64, min_length=1)]


class ExpenseCard(BaseModel):
    """
    One expense: who paid, how much, split between whom.
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: list[str] | None = None
    kind: Literal["expense"]
    expense_id: Annotated[str, Field(max_length=64, min_length=1)]


class SettleUpCard(BaseModel):
    """
    Who pays whom right now, each with a UPI button.
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: list[str] | None = None
    kind: Literal["settle_up"]


class DayCard(BaseModel):
    """
    One day of the itinerary.
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: list[str] | None = None
    kind: Literal["day"]
    date: date_aliased


class PlanCard(BaseModel):
    """
    The whole itinerary, day by day.
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: list[str] | None = None
    kind: Literal["plan"]


class BudgetCard(BaseModel):
    """
    Spent against the plan, by category.
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: list[str] | None = None
    kind: Literal["budget"]


class Option(BaseModel):
    option_id: Annotated[str, Field(max_length=64, min_length=1)]
    title: Annotated[str, Field(max_length=80, min_length=1)]
    subtitle: str | None = None
    image_url: str | None = None
    logo_url: str | None = None
    price_minor: int | None = None
    currency: str | None = None
    price_note: str | None = None
    highlights: Annotated[list[str], Field(max_length=4)]
    journey: Journey | None = None
    place: Place | None = None
    rating: float | None = None
    refundable_until: AwareDatetime | None = None


class OptionsCard(BaseModel):
    """
    Options Go found (stays, flights, places...), with prices and when they were checked.
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: list[str] | None = None
    kind: Literal["options"]
    title: Annotated[str, Field(max_length=80, min_length=1)]
    option_kind: Literal["stay", "flight", "train", "bus", "place", "food", "activity"]
    checked_at: AwareDatetime
    options: Annotated[list[Option], Field(max_length=5, min_length=1)]
    actions: list[CardAction] | None = None


class Step(BaseModel):
    text: Annotated[str, Field(max_length=80, min_length=1)]
    state: Literal["todo", "doing", "done", "failed"]


class WorkingCard(BaseModel):
    """
    Go doing a longer job (booking on a website, comparing many options). Updated in place.
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: list[str] | None = None
    kind: Literal["working"]
    task_id: Annotated[str, Field(max_length=64, min_length=1)]
    title: Annotated[str, Field(max_length=80, min_length=1)]
    state: Literal["running", "needs_you", "done", "failed"]
    steps: Annotated[list[Step], Field(max_length=8)]
    screenshot_url: str | None = None
    updated_at: AwareDatetime
    actions: list[CardAction] | None = None


class LastLine(BaseModel):
    who: Literal["go", "them"]
    text: Annotated[str, Field(max_length=500, min_length=1)]


class TranscriptItem(BaseModel):
    who: Literal["go", "them"]
    text: Annotated[str, Field(max_length=500, min_length=1)]


class CallCard(BaseModel):
    """
    Go on a phone call to a business. Updated in place while it runs; the final version is the record.
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: list[str] | None = None
    kind: Literal["call"]
    call_id: Annotated[str, Field(max_length=64, min_length=1)]
    business: Annotated[str, Field(max_length=80, min_length=1)]
    goal: Annotated[str, Field(max_length=160, min_length=1)]
    state: Literal["dialing", "talking", "ended", "failed"]
    started_at: AwareDatetime | None = None
    ended_at: AwareDatetime | None = None
    last_line: LastLine | None = None
    outcome: str | None = None
    transcript: list[TranscriptItem] | None = None
    actions: list[CardAction] | None = None


class PayCard(BaseModel):
    """
    A payment waiting for the payer. Their "Approve" button opens the vault page, where they confirm with Face ID.
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: list[str] | None = None
    kind: Literal["pay"]
    approval_id: Annotated[str, Field(max_length=64, min_length=1)]
    payer_person_id: Annotated[str, Field(max_length=64, min_length=1)]
    amount_minor: Annotated[int, Field(ge=0)]
    currency: Annotated[str, Field(pattern="^[A-Z]{3}$")]
    merchant: Annotated[str, Field(max_length=120, min_length=1)]
    purpose: Annotated[str, Field(max_length=200, min_length=1)]
    refundable_until: AwareDatetime | None = None
    expires_at: AwareDatetime
    state: Literal["waiting", "paid", "declined", "expired", "failed"]
    actions: list[CardAction] | None = None


class Source(BaseModel):
    name: Annotated[str, Field(max_length=60, min_length=1)]
    url: str | None = None


class NoticeCard(BaseModel):
    """
    Good to know (with its source) or a heads-up (a deadline, a price change, a clash).
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: list[str] | None = None
    kind: Literal["notice"]
    tone: Literal["info", "heads_up"]
    title: Annotated[str, Field(max_length=80, min_length=1)]
    body: Annotated[str, Field(max_length=500, min_length=1)]
    image_url: str | None = None
    source: Source | None = None
    checked_at: AwareDatetime | None = None
    deadline_at: AwareDatetime | None = None
    actions: list[CardAction] | None = None


class PhotoAttachment(BaseModel):
    kind: Literal["photo"]
    url: Annotated[str, Field(pattern="^https?://")]
    width: int | None = None
    height: int | None = None
    caption: str | None = None


class FileAttachment(BaseModel):
    kind: Literal["file"]
    url: Annotated[str, Field(pattern="^https?://")]
    name: Annotated[str, Field(max_length=200, min_length=1)]
    mime: Annotated[str, Field(max_length=100, min_length=1)]
    size_bytes: Annotated[int, Field(ge=0)]


class Reaction(BaseModel):
    emoji: Annotated[str, Field(max_length=16, min_length=1)]
    person_id: str | None = None


class Message(BaseModel):
    message_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]
    updated_seq: Annotated[int, Field(gt=0)]
    author: Annotated[PersonActor | GoActor | SystemActor, Field(discriminator="kind")]
    """
    Who did it: a person, Go, or the server itself (system).
    """
    text: str | None = None
    attachments: Annotated[
        list[Annotated[PhotoAttachment | FileAttachment, Field(discriminator="kind")]],
        Field(max_length=10),
    ]
    reply_to: str | None = None
    about_message_id: str | None = None
    mentions_go: bool
    mentions: Annotated[list[str], Field(max_length=30)]
    reactions: Annotated[list[Reaction], Field(max_length=100)]
    card: (
        VoteCard
        | MandateCard
        | TicketCard
        | ExpenseCard
        | SettleUpCard
        | DayCard
        | PlanCard
        | BudgetCard
        | OptionsCard
        | WorkingCard
        | CallCard
        | PayCard
        | NoticeCard
        | None
    ) = None
    withheld: bool
    deleted: bool
    edited_at: AwareDatetime | None = None
    sent_at: AwareDatetime


class MessagesPage(BaseModel):
    messages: Annotated[list[Message], Field(max_length=200)]
    has_more: bool


class PostMessage(BaseModel):
    """
    Needs text, a card, or both.
    """

    request_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    text: str | None = None
    card: (
        VoteCard
        | MandateCard
        | TicketCard
        | ExpenseCard
        | SettleUpCard
        | DayCard
        | PlanCard
        | BudgetCard
        | OptionsCard
        | WorkingCard
        | CallCard
        | PayCard
        | NoticeCard
        | None
    ) = None
    reply_to: str | None = None
    mentions: list[str] | None = None


class PostMessageResult(BaseModel):
    message_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]


class ReplaceCard(BaseModel):
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    card: Annotated[
        VoteCard
        | MandateCard
        | TicketCard
        | ExpenseCard
        | SettleUpCard
        | DayCard
        | PlanCard
        | BudgetCard
        | OptionsCard
        | WorkingCard
        | CallCard
        | PayCard
        | NoticeCard,
        Field(discriminator="kind"),
    ]


class ReplaceCardResult(BaseModel):
    message_id: Annotated[str, Field(max_length=64, min_length=1)]


class GoTyping(BaseModel):
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    on: bool


class DecisionOption(BaseModel):
    label: Annotated[str, Field(max_length=120, min_length=1)]
    image_url: str | None = None
    price_minor: int | None = None
    currency: str | None = None
    option_ref: str | None = None
    note: str | None = None


class Mandate(BaseModel):
    choice_index: Annotated[int, Field(ge=0)]
    cap_minor: Annotated[int, Field(ge=0)]
    currency: Annotated[str, Field(pattern="^[A-Z]{3}$")]
    refundable_only: bool
    payer_person_id: Annotated[str, Field(max_length=64, min_length=1)]
    set_at: AwareDatetime
    confirmed_at: AwareDatetime | None = None
    declined_at: AwareDatetime | None = None


class Vote(BaseModel):
    person_id: Annotated[str, Field(max_length=64, min_length=1)]
    option_index: Annotated[int, Field(ge=0)]


class Decision(BaseModel):
    decision_id: Annotated[str, Field(max_length=64, min_length=1)]
    question: Annotated[str, Field(max_length=200, min_length=1)]
    kind: Literal["choice", "yesno"]
    anonymous: bool
    status: Literal["open", "closed", "cancelled"]
    opened_by_person_id: str | None = None
    options: Annotated[list[DecisionOption], Field(max_length=10, min_length=2)]
    closes_at: AwareDatetime | None = None
    voted: Annotated[int, Field(ge=0)]
    of: Annotated[int, Field(ge=0)]
    tally: Annotated[list[int], Field(max_length=10)]
    votes: list[Vote] | None = None
    result_index: int | None = None
    mandate: Mandate | None = None
    opened_at: AwareDatetime
    closed_at: AwareDatetime | None = None


class Booking(BaseModel):
    booking_id: Annotated[str, Field(max_length=64, min_length=1)]
    kind: Literal["stay", "flight", "train", "bus", "cab", "table", "activity", "other"]
    status: Literal["confirmed", "cancelled"]
    title: Annotated[str, Field(max_length=120, min_length=1)]
    vendor: Annotated[str, Field(max_length=80, min_length=1)]
    ref: Annotated[str, Field(max_length=80, min_length=1)]
    amount_minor: Annotated[int, Field(ge=0)]
    currency: Annotated[str, Field(pattern="^[A-Z]{3}$")]
    payer_person_id: Annotated[str, Field(max_length=64, min_length=1)]
    for_person_ids: Annotated[list[str], Field(max_length=30, min_length=1)]
    refundable_until: AwareDatetime | None = None
    starts_at: AwareDatetime | None = None
    ends_at: AwareDatetime | None = None
    journey: Journey | None = None
    place: Place | None = None
    image_url: str | None = None
    decision_id: str | None = None
    approval_id: str | None = None
    added_by_person_id: str | None = None
    created_at: AwareDatetime


class Expense(BaseModel):
    expense_id: Annotated[str, Field(max_length=64, min_length=1)]
    paid_by_person_id: Annotated[str, Field(max_length=64, min_length=1)]
    amount_minor: Annotated[int, Field(ge=0)]
    currency: Annotated[str, Field(pattern="^[A-Z]{3}$")]
    note: Annotated[str, Field(max_length=120, min_length=1)]
    category: Literal["stay", "food", "getting_around", "activities", "other"]
    """
    The spending category. The app colours: stay blue, food orange, getting around green, activities yellow.
    """
    split_person_ids: Annotated[list[str], Field(max_length=30, min_length=1)]
    booking_id: str | None = None
    added_by_person_id: str | None = None
    created_at: AwareDatetime


class Transfer(BaseModel):
    from_person_id: Annotated[str, Field(max_length=64, min_length=1)]
    to_person_id: Annotated[str, Field(max_length=64, min_length=1)]
    amount_minor: Annotated[int, Field(ge=0)]
    currency: Annotated[str, Field(pattern="^[A-Z]{3}$")]


class ByCategoryItem(BaseModel):
    category: Literal["stay", "food", "getting_around", "activities", "other"]
    """
    The spending category. The app colours: stay blue, food orange, getting around green, activities yellow.
    """
    amount_minor: Annotated[int, Field(ge=0)]


class Money(BaseModel):
    currency: Annotated[str, Field(pattern="^[A-Z]{3}$")]
    plan_minor: int | None = None
    spent_minor: Annotated[int, Field(ge=0)]
    by_category: Annotated[list[ByCategoryItem], Field(max_length=5)]
    transfers: Annotated[list[Transfer], Field(max_length=60)]


class ItineraryItem(BaseModel):
    item_id: str | None = None
    time: str | None = None
    title: Annotated[str, Field(max_length=120, min_length=1)]
    category: Literal["stay", "food", "getting_around", "activities", "other"]
    """
    The spending category. The app colours: stay blue, food orange, getting around green, activities yellow.
    """
    place: Place | None = None
    booking_id: str | None = None
    status: Literal["booked", "planned", "idea"]
    note: str | None = None


class Day(BaseModel):
    date: date_aliased
    title: str | None = None
    items: Annotated[list[ItineraryItem], Field(max_length=20)]


class Proof(BaseModel):
    message_id: Annotated[str, Field(max_length=64, min_length=1)]
    person_id: str | None = None


class RecordLine(BaseModel):
    line_id: Annotated[str, Field(max_length=64, min_length=1)]
    kind: Literal["decided", "agreed", "open", "doing", "booked"]
    text: Annotated[str, Field(max_length=200, min_length=1)]
    status: Literal["active", "done", "undone"]
    proof: Annotated[list[Proof], Field(max_length=10)]
    person_ids: Annotated[list[str], Field(max_length=30)]
    due_at: AwareDatetime | None = None
    decision_id: str | None = None
    booking_id: str | None = None
    source: Literal["go", "person", "vote", "booking"]
    created_at: AwareDatetime
    updated_at: AwareDatetime


class Dates(BaseModel):
    start: date_aliased
    end: date_aliased


class TripSnapshot(BaseModel):
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]
    title: Annotated[str, Field(max_length=80, min_length=1)]
    status: Literal["planning", "booked", "on_trip", "over"]
    created_at: AwareDatetime
    organizer_person_id: Annotated[str, Field(max_length=64, min_length=1)]
    invite_url: Annotated[str, Field(pattern="^https?://")]
    destination: Place | None = None
    dates: Dates | None = None
    vibe: Annotated[list[str], Field(max_length=12)]
    stay: str | None = None
    budget: BudgetSummary
    people: Annotated[list[Person], Field(max_length=30)]
    decisions: Annotated[list[Decision], Field(max_length=100)]
    bookings: Annotated[list[Booking], Field(max_length=100)]
    expenses: Annotated[list[Expense], Field(max_length=500)]
    money: Money
    itinerary: Annotated[list[Day], Field(max_length=30)]
    record: Annotated[list[RecordLine], Field(max_length=300)]


class MessageCreatedData(BaseModel):
    message: Message


class MessageCreated(BaseModel):
    """
    Someone posted in the room (Go's own messages come back too).
    """

    event_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]
    occurred_at: AwareDatetime
    type: Literal["message.created"]
    data: MessageCreatedData


class MessageEditedData(BaseModel):
    message: Message


class MessageEdited(BaseModel):
    """
    Someone edited a message. Carries the message as it is now.
    """

    event_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]
    occurred_at: AwareDatetime
    type: Literal["message.edited"]
    data: MessageEditedData


class MessageDeletedData(BaseModel):
    message_id: Annotated[str, Field(max_length=64, min_length=1)]


class MessageDeleted(BaseModel):
    """
    Someone deleted a message. Go drops anything it learned from it.
    """

    event_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]
    occurred_at: AwareDatetime
    type: Literal["message.deleted"]
    data: MessageDeletedData


class ReactionAddedData(BaseModel):
    message_id: Annotated[str, Field(max_length=64, min_length=1)]
    reaction: Reaction


class ReactionAdded(BaseModel):
    """
    Someone reacted to a message. A thumbs up can count as agreeing.
    """

    event_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]
    occurred_at: AwareDatetime
    type: Literal["reaction.added"]
    data: ReactionAddedData


class ReactionRemovedData(BaseModel):
    message_id: Annotated[str, Field(max_length=64, min_length=1)]
    reaction: Reaction


class ReactionRemoved(BaseModel):
    """
    Someone took a reaction back.
    """

    event_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]
    occurred_at: AwareDatetime
    type: Literal["reaction.removed"]
    data: ReactionRemovedData


class PersonJoinedData(BaseModel):
    person: Person


class PersonJoined(BaseModel):
    """
    Someone joined the trip, with their join answers (never their budget answer).
    """

    event_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]
    occurred_at: AwareDatetime
    type: Literal["person.joined"]
    data: PersonJoinedData


class PersonUpdatedData(BaseModel):
    person: Person
    changed: Annotated[
        list[
            Literal[
                "name",
                "photo_url",
                "from_city",
                "earliest_leave",
                "know",
                "has_upi",
                "go_paused",
                "role",
            ]
        ],
        Field(min_length=1),
    ]


class PersonUpdated(BaseModel):
    """
    Someone changed their details, or paused or unpaused Go.
    """

    event_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]
    occurred_at: AwareDatetime
    type: Literal["person.updated"]
    data: PersonUpdatedData


class PersonLeftData(BaseModel):
    person_id: Annotated[str, Field(max_length=64, min_length=1)]


class PersonLeft(BaseModel):
    """
    Someone left the trip.
    """

    event_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]
    occurred_at: AwareDatetime
    type: Literal["person.left"]
    data: PersonLeftData


class TripCreatedData(BaseModel):
    trip: TripSnapshot


class TripCreated(BaseModel):
    """
    A new trip room. Carries the whole trip, so Go can greet the group and start.
    """

    event_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]
    occurred_at: AwareDatetime
    type: Literal["trip.created"]
    data: TripCreatedData


class TripUpdatedData(BaseModel):
    by: Annotated[PersonActor | GoActor | SystemActor, Field(discriminator="kind")]
    """
    Who did it: a person, Go, or the server itself (system).
    """
    changed: Annotated[
        list[
            Literal[
                "title",
                "destination",
                "dates",
                "vibe",
                "stay",
                "itinerary",
                "status",
                "budget",
            ]
        ],
        Field(min_length=1),
    ]


class TripUpdated(BaseModel):
    """
    Trip details changed. Read the trip to see the new values.
    """

    event_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]
    occurred_at: AwareDatetime
    type: Literal["trip.updated"]
    data: TripUpdatedData


class DecisionOpenedData(BaseModel):
    decision: Decision
    by: Annotated[PersonActor | GoActor | SystemActor, Field(discriminator="kind")]
    """
    Who did it: a person, Go, or the server itself (system).
    """


class DecisionOpened(BaseModel):
    """
    A vote opened.
    """

    event_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]
    occurred_at: AwareDatetime
    type: Literal["decision.opened"]
    data: DecisionOpenedData


class DecisionVotedData(BaseModel):
    decision_id: Annotated[str, Field(max_length=64, min_length=1)]
    person_id: str | None = None
    option_index: int | None = None
    voted: Annotated[int, Field(ge=0)]
    of: Annotated[int, Field(ge=0)]
    tally: Annotated[list[int], Field(max_length=10)]


class DecisionVoted(BaseModel):
    """
    Someone voted (or changed their vote).
    """

    event_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]
    occurred_at: AwareDatetime
    type: Literal["decision.voted"]
    data: DecisionVotedData


class DecisionClosedData(BaseModel):
    decision: Decision
    reason: Literal["time", "everyone_voted", "closed_by_person", "closed_by_go"]


class DecisionClosed(BaseModel):
    """
    A vote closed, with the result.
    """

    event_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]
    occurred_at: AwareDatetime
    type: Literal["decision.closed"]
    data: DecisionClosedData


class DecisionCancelledData(BaseModel):
    decision_id: Annotated[str, Field(max_length=64, min_length=1)]
    by: Annotated[PersonActor | GoActor | SystemActor, Field(discriminator="kind")]
    """
    Who did it: a person, Go, or the server itself (system).
    """


class DecisionCancelled(BaseModel):
    """
    A vote was called off.
    """

    event_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]
    occurred_at: AwareDatetime
    type: Literal["decision.cancelled"]
    data: DecisionCancelledData


class MandateSetData(BaseModel):
    decision_id: Annotated[str, Field(max_length=64, min_length=1)]
    mandate: Mandate


class MandateSet(BaseModel):
    """
    Go set what the group allowed for a spend.
    """

    event_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]
    occurred_at: AwareDatetime
    type: Literal["mandate.set"]
    data: MandateSetData


class MandateConfirmedData(BaseModel):
    decision_id: Annotated[str, Field(max_length=64, min_length=1)]
    person_id: Annotated[str, Field(max_length=64, min_length=1)]


class MandateConfirmed(BaseModel):
    """
    The payer tapped "Yes, book it". Go may now ask for a spend approval.
    """

    event_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]
    occurred_at: AwareDatetime
    type: Literal["mandate.confirmed"]
    data: MandateConfirmedData


class MandateDeclinedData(BaseModel):
    decision_id: Annotated[str, Field(max_length=64, min_length=1)]
    person_id: Annotated[str, Field(max_length=64, min_length=1)]


class MandateDeclined(BaseModel):
    """
    The payer tapped "Not now".
    """

    event_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]
    occurred_at: AwareDatetime
    type: Literal["mandate.declined"]
    data: MandateDeclinedData


class RecordChangedData(BaseModel):
    line: RecordLine
    change: Literal["added", "updated", "done", "undone"]
    by: Annotated[PersonActor | GoActor | SystemActor, Field(discriminator="kind")]
    """
    Who did it: a person, Go, or the server itself (system).
    """


class RecordChanged(BaseModel):
    """
    A trip record line was added, changed, finished or undone.
    """

    event_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]
    occurred_at: AwareDatetime
    type: Literal["record.changed"]
    data: RecordChangedData


class BookingChangedData(BaseModel):
    booking: Booking
    change: Literal["added", "updated", "cancelled"]
    by: Annotated[PersonActor | GoActor | SystemActor, Field(discriminator="kind")]
    """
    Who did it: a person, Go, or the server itself (system).
    """


class BookingChanged(BaseModel):
    """
    A booking was added, changed or cancelled.
    """

    event_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]
    occurred_at: AwareDatetime
    type: Literal["booking.changed"]
    data: BookingChangedData


class ExpenseChangedData(BaseModel):
    expense: Expense
    change: Literal["added", "removed"]
    by: Annotated[PersonActor | GoActor | SystemActor, Field(discriminator="kind")]
    """
    Who did it: a person, Go, or the server itself (system).
    """


class ExpenseChanged(BaseModel):
    """
    An expense was added or removed.
    """

    event_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]
    occurred_at: AwareDatetime
    type: Literal["expense.changed"]
    data: ExpenseChangedData


class Event(
    RootModel[
        MessageCreated
        | MessageEdited
        | MessageDeleted
        | ReactionAdded
        | ReactionRemoved
        | PersonJoined
        | PersonUpdated
        | PersonLeft
        | TripCreated
        | TripUpdated
        | DecisionOpened
        | DecisionVoted
        | DecisionClosed
        | DecisionCancelled
        | MandateSet
        | MandateConfirmed
        | MandateDeclined
        | RecordChanged
        | BookingChanged
        | ExpenseChanged
    ]
):
    root: Annotated[
        MessageCreated
        | MessageEdited
        | MessageDeleted
        | ReactionAdded
        | ReactionRemoved
        | PersonJoined
        | PersonUpdated
        | PersonLeft
        | TripCreated
        | TripUpdated
        | DecisionOpened
        | DecisionVoted
        | DecisionClosed
        | DecisionCancelled
        | MandateSet
        | MandateConfirmed
        | MandateDeclined
        | RecordChanged
        | BookingChanged
        | ExpenseChanged,
        Field(discriminator="type"),
    ]


class ReadTrip(BaseModel):
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]


class ReadMessages(BaseModel):
    """
    Up to 200 at a time; 200 when limit is left out. The server sends fewer, with has_more: true, when the answer would go over the 1 MB frame limit.
    """

    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    after_seq: Annotated[int, Field(ge=0)]
    limit: int | None = None


class WriteResult(BaseModel):
    seq: Annotated[int, Field(gt=0)]


class UpdateTrip(BaseModel):
    """
    Only the fields sent change.
    """

    request_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    title: str | None = None
    destination: Place | None = None
    dates: Dates | None = None
    vibe: list[str] | None = None
    stay: str | None = None
    itinerary: list[Day] | None = None


class OpenDecision(BaseModel):
    """
    Opens a vote. Go then posts a message with a vote card to show it in the room.
    """

    request_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    question: Annotated[str, Field(max_length=200, min_length=1)]
    kind: Literal["choice", "yesno"]
    anonymous: bool
    options: Annotated[list[DecisionOption], Field(max_length=10, min_length=2)]
    closes_at: AwareDatetime | None = None


class OpenDecisionResult(BaseModel):
    decision_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]


class CloseDecision(BaseModel):
    request_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    decision_id: Annotated[str, Field(max_length=64, min_length=1)]


class CloseDecisionResult(BaseModel):
    decision: Decision
    seq: Annotated[int, Field(gt=0)]


class SetMandate(BaseModel):
    """
    Sets (or replaces) what the group allowed for a closed choice vote. Replacing clears the payer's earlier yes or no.
    """

    request_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    decision_id: Annotated[str, Field(max_length=64, min_length=1)]
    choice_index: Annotated[int, Field(ge=0)]
    cap_minor: Annotated[int, Field(gt=0)]
    currency: Annotated[str, Field(pattern="^[A-Z]{3}$")]
    refundable_only: bool
    payer_person_id: Annotated[str, Field(max_length=64, min_length=1)]


class AddRecordLine(BaseModel):
    request_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    kind: Literal["agreed", "open", "doing"]
    text: Annotated[str, Field(max_length=200, min_length=1)]
    proof: Annotated[list[Proof], Field(max_length=10)]
    person_ids: Annotated[list[str], Field(max_length=30)]
    due_at: AwareDatetime | None = None


class AddRecordLineResult(BaseModel):
    line_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]


class UpdateRecordLine(BaseModel):
    """
    Only the fields sent change. Go cannot undo a line; only people can.
    """

    request_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    line_id: Annotated[str, Field(max_length=64, min_length=1)]
    kind: Literal["agreed", "open", "doing"] | None = None
    text: str | None = None
    status: Literal["active", "done"] | None = None
    proof: list[Proof] | None = None
    person_ids: list[str] | None = None
    due_at: AwareDatetime | None = None


class AddBooking(BaseModel):
    request_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    kind: Literal["stay", "flight", "train", "bus", "cab", "table", "activity", "other"]
    title: Annotated[str, Field(max_length=120, min_length=1)]
    vendor: Annotated[str, Field(max_length=80, min_length=1)]
    ref: Annotated[str, Field(max_length=80, min_length=1)]
    amount_minor: Annotated[int, Field(ge=0)]
    currency: Annotated[str, Field(pattern="^[A-Z]{3}$")]
    payer_person_id: Annotated[str, Field(max_length=64, min_length=1)]
    for_person_ids: Annotated[list[str], Field(max_length=30, min_length=1)]
    refundable_until: AwareDatetime | None = None
    starts_at: AwareDatetime | None = None
    ends_at: AwareDatetime | None = None
    journey: Journey | None = None
    place: Place | None = None
    image_url: str | None = None
    decision_id: str | None = None
    approval_id: str | None = None


class AddBookingResult(BaseModel):
    booking_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]


class UpdateBooking(BaseModel):
    """
    Only the fields sent change.
    """

    request_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    booking_id: Annotated[str, Field(max_length=64, min_length=1)]
    status: Literal["cancelled"] | None = None
    ref: str | None = None
    refundable_until: AwareDatetime | None = None
    starts_at: AwareDatetime | None = None
    ends_at: AwareDatetime | None = None


class AddExpense(BaseModel):
    request_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    paid_by_person_id: Annotated[str, Field(max_length=64, min_length=1)]
    amount_minor: Annotated[int, Field(gt=0)]
    currency: Annotated[str, Field(pattern="^[A-Z]{3}$")]
    note: Annotated[str, Field(max_length=120, min_length=1)]
    category: Literal["stay", "food", "getting_around", "activities", "other"]
    """
    The spending category. The app colours: stay blue, food orange, getting around green, activities yellow.
    """
    split_person_ids: Annotated[list[str], Field(max_length=30, min_length=1)]
    booking_id: str | None = None


class AddExpenseResult(BaseModel):
    expense_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]


class RequestSpendApproval(BaseModel):
    request_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    decision_id: Annotated[str, Field(max_length=64, min_length=1)]
    amount_minor: Annotated[int, Field(gt=0)]
    currency: Annotated[str, Field(pattern="^[A-Z]{3}$")]
    merchant: Annotated[str, Field(max_length=120, min_length=1)]
    purpose: Annotated[str, Field(max_length=200, min_length=1)]
    refundable_until: AwareDatetime | None = None


class CancelSpendApproval(BaseModel):
    request_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    approval_id: Annotated[str, Field(max_length=64, min_length=1)]
    reason: Literal[
        "payment_failed", "payer_declined", "price_changed", "expired", "other"
    ]


class SpendApproved(BaseModel):
    status: Literal["approved"]
    approval_id: Annotated[str, Field(max_length=64, min_length=1)]
    approval: Annotated[str, Field(max_length=4096, min_length=1)]
    expires_at: AwareDatetime


class SpendDenied(BaseModel):
    status: Literal["denied"]
    reason: Literal[
        "decision_not_found",
        "decision_not_closed",
        "no_mandate",
        "payer_has_not_confirmed",
        "payer_declined",
        "over_cap",
        "currency_mismatch",
        "not_refundable",
        "approval_outstanding",
    ]
    detail: str | None = None


class SpendApprovalResult(RootModel[SpendApproved | SpendDenied]):
    root: Annotated[SpendApproved | SpendDenied, Field(discriminator="status")]


class AddReaction(BaseModel):
    request_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    message_id: Annotated[str, Field(max_length=64, min_length=1)]
    emoji: Annotated[str, Field(max_length=16, min_length=1)]


class RemoveReaction(BaseModel):
    request_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    message_id: Annotated[str, Field(max_length=64, min_length=1)]
    emoji: Annotated[str, Field(max_length=16, min_length=1)]


class EventAccepted(BaseModel):
    accepted: Literal[True]
    duplicate: bool


class CardTap(BaseModel):
    tap_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    action_id: Annotated[str, Field(pattern="^[a-z][a-z_]{0,31}$")]
    person_id: Annotated[str, Field(max_length=64, min_length=1)]
    option_id: str | None = None


class ActionDone(BaseModel):
    result: Literal["done"]
    toast: str | None = None


class ActionOpen(BaseModel):
    result: Literal["open"]
    url: Annotated[str, Field(pattern="^https?://")]
    expires_at: AwareDatetime


class ActionRefused(BaseModel):
    result: Literal["refused"]
    toast: Annotated[str, Field(max_length=120, min_length=1)]


class CardActionResult(RootModel[ActionDone | ActionOpen | ActionRefused]):
    root: Annotated[
        ActionDone | ActionOpen | ActionRefused, Field(discriminator="result")
    ]


class CatchUpRequest(BaseModel):
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    person_id: Annotated[str, Field(max_length=64, min_length=1)]
    since: AwareDatetime


class Item(BaseModel):
    kind: Literal["decided", "booked", "needs_you", "open", "news"]
    text: Annotated[str, Field(max_length=140, min_length=1)]
    image_url: str | None = None
    message_id: str | None = None


class CatchUp(BaseModel):
    """
    For one person only. Shown above the room, never posted in it.
    """

    summary: str | None = None
    items: Annotated[list[Item], Field(max_length=5)]


class Fact(BaseModel):
    fact_id: Annotated[str, Field(max_length=64, min_length=1)]
    topic: Annotated[str, Field(max_length=40, min_length=1)]
    text: Annotated[str, Field(max_length=200, min_length=1)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    message_id: str | None = None
    said_at: AwareDatetime


class PersonPage(BaseModel):
    person_id: Annotated[str, Field(max_length=64, min_length=1)]
    carry_over: bool
    facts: Annotated[list[Fact], Field(max_length=500)]


class GetPerson(BaseModel):
    person_id: Annotated[str, Field(max_length=64, min_length=1)]


class UpdatePerson(BaseModel):
    person_id: Annotated[str, Field(max_length=64, min_length=1)]
    carry_over: bool


class DeleteFact(BaseModel):
    person_id: Annotated[str, Field(max_length=64, min_length=1)]
    fact_id: Annotated[str, Field(max_length=64, min_length=1)]


class ForgetPerson(BaseModel):
    person_id: Annotated[str, Field(max_length=64, min_length=1)]
    trip_id: str | None = None


class Ok(BaseModel):
    ok: Literal[True]


class ForgetResult(BaseModel):
    deleted_facts: Annotated[int, Field(ge=0)]
    remaining_facts: Literal[0]


class CreateLink(BaseModel):
    kind: Literal["vault"]
    person_id: Annotated[str, Field(max_length=64, min_length=1)]
    start: Literal["home", "add_card", "add_login"] | None = None


class Link(BaseModel):
    url: Annotated[str, Field(pattern="^https?://")]
    expires_at: AwareDatetime


class Health(BaseModel):
    ok: Literal[True]
    contract: str


class Error(BaseModel):
    code: Literal[
        "bad_signature",
        "not_found",
        "invalid",
        "conflict",
        "rate_limited",
        "internal",
        "unavailable",
    ]
    message: Annotated[str, Field(max_length=500)]


class ErrorBody(BaseModel):
    error: Error


class SocketRequest(BaseModel):
    """
    A request. The other side answers it once, with a result or an error, using the same id.
    """

    jsonrpc: Literal["2.0"]
    id: Annotated[str, Field(max_length=64, min_length=1)]
    method: Annotated[str, Field(max_length=64, min_length=1)]
    params: dict[str, Any]


class SocketNotification(BaseModel):
    """
    A notification: no id, no answer. Used only for Go's typing.
    """

    jsonrpc: Literal["2.0"]
    method: Annotated[str, Field(max_length=64, min_length=1)]
    params: dict[str, Any]


class SocketResult(BaseModel):
    """
    The answer to a request that worked.
    """

    jsonrpc: Literal["2.0"]
    id: Annotated[str, Field(max_length=64, min_length=1)]
    result: dict[str, Any]


class Data(BaseModel):
    code: Literal[
        "bad_signature",
        "not_found",
        "invalid",
        "conflict",
        "rate_limited",
        "internal",
        "unavailable",
    ]
    retry_after_seconds: int | None = None


class Error1(BaseModel):
    code: Annotated[int, Field(ge=-9007199254740991)]
    message: Annotated[str, Field(max_length=500)]
    data: Data | None = None


class SocketError(BaseModel):
    """
    The answer to a request that did not work.
    """

    jsonrpc: Literal["2.0"]
    id: str | None
    error: Error1


class SpendApprovalClaims(BaseModel):
    """
    What the server signs. exp is at most 600 seconds after iat.
    """

    iss: Literal["server"]
    aud: Literal["go-brain-vault"]
    jti: Annotated[str, Field(max_length=64, min_length=8)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    decision_id: Annotated[str, Field(max_length=64, min_length=1)]
    payer_person_id: Annotated[str, Field(max_length=64, min_length=1)]
    amount_minor: Annotated[int, Field(gt=0)]
    currency: Annotated[str, Field(pattern="^[A-Z]{3}$")]
    merchant: Annotated[str, Field(max_length=120, min_length=1)]
    purpose: Annotated[str, Field(max_length=200, min_length=1)]
    refundable_until: AwareDatetime | None = None
    iat: Annotated[int, Field(ge=-9007199254740991)]
    exp: Annotated[int, Field(ge=-9007199254740991)]
