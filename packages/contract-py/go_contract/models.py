# Generated from packages/contract/openapi/go-server.json by scripts/gen_models.py. Do not edit.

from __future__ import annotations

from datetime import date as date_aliased
from typing import Annotated, Literal

from pydantic import AnyUrl, AwareDatetime, BaseModel, Field, RootModel


class PersonActor(BaseModel):
    kind: Literal["person"]
    person_id: Annotated[str, Field(max_length=64, min_length=1)]


class GoActor(BaseModel):
    kind: Literal["go"]


class SystemActor(BaseModel):
    kind: Literal["system"]


class Place(BaseModel):
    name: Annotated[str, Field(max_length=120, min_length=1)]
    place_id: Annotated[str | None, Field(max_length=256)] = None
    address: Annotated[str | None, Field(max_length=200)] = None
    lat: Annotated[float | None, Field(ge=-90.0, le=90.0)] = None
    lng: Annotated[float | None, Field(ge=-180.0, le=180.0)] = None
    photo_url: AnyUrl | None = None


class From(BaseModel):
    name: Annotated[str, Field(max_length=80, min_length=1)]
    code: Annotated[str | None, Field(max_length=8)] = None


class To(BaseModel):
    name: Annotated[str, Field(max_length=80, min_length=1)]
    code: Annotated[str | None, Field(max_length=8)] = None


class Journey(BaseModel):
    mode: Literal["flight", "train", "bus", "cab"]
    from_: Annotated[From, Field(alias="from")]
    to: To
    depart_at: AwareDatetime
    arrive_at: AwareDatetime
    carrier_name: Annotated[str | None, Field(max_length=60)] = None
    carrier_code: Annotated[str | None, Field(max_length=8)] = None
    number: Annotated[str | None, Field(max_length=20)] = None
    logo_url: AnyUrl | None = None
    stops: Annotated[int | None, Field(ge=0)] = None


class Person(BaseModel):
    person_id: Annotated[str, Field(max_length=64, min_length=1)]
    name: Annotated[str, Field(max_length=80, min_length=1)]
    photo_url: AnyUrl | None = None
    role: Literal["organizer", "member"]
    joined_at: AwareDatetime
    from_city: Annotated[str | None, Field(max_length=60)] = None
    earliest_leave: Annotated[str | None, Field(max_length=60)] = None
    know: Annotated[list[str], Field(max_length=20)]
    has_upi: bool
    go_paused: bool


class BudgetBand(BaseModel):
    min_minor: Annotated[int, Field(ge=0)]
    max_minor: int | None
    currency: Annotated[str, Field(pattern="^[A-Z]{3}$")]


class BudgetSummary(BaseModel):
    lowest: BudgetBand | None
    answered: Annotated[int, Field(ge=0)]
    of: Annotated[int, Field(ge=0)]


class CardAction(BaseModel):
    action_id: Annotated[str, Field(pattern="^[a-z][a-z_]{0,31}$")]
    label: Annotated[str, Field(max_length=24, min_length=1)]
    style: Literal["primary", "secondary"]
    only_for_person_ids: Annotated[list[str] | None, Field(max_length=30)] = None
    per_option: bool | None = None


class VoteCard(BaseModel):
    """
    A vote. go-server draws the options, the tally and the vote buttons.
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: Annotated[list[str] | None, Field(max_length=30)] = None
    kind: Literal["vote"]
    decision_id: Annotated[str, Field(max_length=64, min_length=1)]


class MandateCard(BaseModel):
    """
    Ready to book: what the group allowed (the choice, the cap, refundable or not, who pays). go-server shows "Yes, book it" and "Not now" to the payer only.
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: Annotated[list[str] | None, Field(max_length=30)] = None
    kind: Literal["mandate"]
    decision_id: Annotated[str, Field(max_length=64, min_length=1)]


class TicketCard(BaseModel):
    """
    A booking, drawn as a ticket (boarding pass, stay pass, table).
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: Annotated[list[str] | None, Field(max_length=30)] = None
    kind: Literal["ticket"]
    booking_id: Annotated[str, Field(max_length=64, min_length=1)]


class ExpenseCard(BaseModel):
    """
    One expense: who paid, how much, split between whom.
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: Annotated[list[str] | None, Field(max_length=30)] = None
    kind: Literal["expense"]
    expense_id: Annotated[str, Field(max_length=64, min_length=1)]


class SettleUpCard(BaseModel):
    """
    Who pays whom right now, each with a UPI button.
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: Annotated[list[str] | None, Field(max_length=30)] = None
    kind: Literal["settle_up"]


class DayCard(BaseModel):
    """
    One day of the itinerary.
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: Annotated[list[str] | None, Field(max_length=30)] = None
    kind: Literal["day"]
    date: date_aliased


class PlanCard(BaseModel):
    """
    The whole itinerary, day by day.
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: Annotated[list[str] | None, Field(max_length=30)] = None
    kind: Literal["plan"]


class BudgetCard(BaseModel):
    """
    Spent against the plan, by category.
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: Annotated[list[str] | None, Field(max_length=30)] = None
    kind: Literal["budget"]


class Option(BaseModel):
    option_id: Annotated[str, Field(max_length=64, min_length=1)]
    title: Annotated[str, Field(max_length=80, min_length=1)]
    subtitle: Annotated[str | None, Field(max_length=120)] = None
    image_url: AnyUrl | None = None
    logo_url: AnyUrl | None = None
    price_minor: Annotated[int | None, Field(ge=0)] = None
    currency: Annotated[str | None, Field(pattern="^[A-Z]{3}$")] = None
    price_note: Annotated[str | None, Field(max_length=40)] = None
    highlights: Annotated[list[str], Field(max_length=4)]
    journey: Journey | None = None
    place: Place | None = None
    rating: Annotated[float | None, Field(ge=0.0, le=5.0)] = None
    refundable_until: AwareDatetime | None = None


class OptionsCard(BaseModel):
    """
    Options Go found (stays, flights, places...), with prices and when they were checked.
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: Annotated[list[str] | None, Field(max_length=30)] = None
    kind: Literal["options"]
    title: Annotated[str, Field(max_length=80, min_length=1)]
    option_kind: Literal["stay", "flight", "train", "bus", "place", "food", "activity"]
    checked_at: AwareDatetime
    options: Annotated[list[Option], Field(max_length=5, min_length=1)]
    actions: Annotated[list[CardAction] | None, Field(max_length=3)] = None


class Step(BaseModel):
    text: Annotated[str, Field(max_length=80, min_length=1)]
    state: Literal["todo", "doing", "done", "failed"]


class WorkingCard(BaseModel):
    """
    Go doing a longer job (booking on a website, comparing many options). Updated in place.
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: Annotated[list[str] | None, Field(max_length=30)] = None
    kind: Literal["working"]
    task_id: Annotated[str, Field(max_length=64, min_length=1)]
    title: Annotated[str, Field(max_length=80, min_length=1)]
    state: Literal["running", "needs_you", "done", "failed"]
    steps: Annotated[list[Step], Field(max_length=8)]
    screenshot_url: AnyUrl | None = None
    updated_at: AwareDatetime
    actions: Annotated[list[CardAction] | None, Field(max_length=3)] = None


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
    for_person_ids: Annotated[list[str] | None, Field(max_length=30)] = None
    kind: Literal["call"]
    call_id: Annotated[str, Field(max_length=64, min_length=1)]
    business: Annotated[str, Field(max_length=80, min_length=1)]
    goal: Annotated[str, Field(max_length=160, min_length=1)]
    state: Literal["dialing", "talking", "ended", "failed"]
    started_at: AwareDatetime | None = None
    ended_at: AwareDatetime | None = None
    last_line: LastLine | None = None
    outcome: Annotated[str | None, Field(max_length=500)] = None
    transcript: Annotated[list[TranscriptItem] | None, Field(max_length=300)] = None
    actions: Annotated[list[CardAction] | None, Field(max_length=3)] = None


class PayCard(BaseModel):
    """
    A payment waiting for the payer. Their "Approve" button opens the vault page, where they confirm with Face ID.
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: Annotated[list[str] | None, Field(max_length=30)] = None
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
    actions: Annotated[list[CardAction] | None, Field(max_length=3)] = None


class Source(BaseModel):
    name: Annotated[str, Field(max_length=60, min_length=1)]
    url: AnyUrl | None = None


class NoticeCard(BaseModel):
    """
    Good to know (with its source) or a heads-up (a deadline, a price change, a clash).
    """

    card_id: Annotated[str, Field(max_length=64, min_length=1)]
    fallback_text: Annotated[str, Field(max_length=300, min_length=1)]
    for_person_ids: Annotated[list[str] | None, Field(max_length=30)] = None
    kind: Literal["notice"]
    tone: Literal["info", "heads_up"]
    title: Annotated[str, Field(max_length=80, min_length=1)]
    body: Annotated[str, Field(max_length=500, min_length=1)]
    image_url: AnyUrl | None = None
    source: Source | None = None
    checked_at: AwareDatetime | None = None
    deadline_at: AwareDatetime | None = None
    actions: Annotated[list[CardAction] | None, Field(max_length=3)] = None


class PhotoAttachment(BaseModel):
    kind: Literal["photo"]
    url: AnyUrl
    width: Annotated[int | None, Field(gt=0)] = None
    height: Annotated[int | None, Field(gt=0)] = None
    caption: Annotated[str | None, Field(max_length=500)] = None


class FileAttachment(BaseModel):
    kind: Literal["file"]
    url: AnyUrl
    name: Annotated[str, Field(max_length=200, min_length=1)]
    mime: Annotated[str, Field(max_length=100, min_length=1)]
    size_bytes: Annotated[int, Field(ge=0)]


class Reaction(BaseModel):
    emoji: Annotated[str, Field(max_length=16, min_length=1)]
    person_id: Annotated[str, Field(max_length=64, min_length=1)]


class Message(BaseModel):
    message_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]
    author: Annotated[PersonActor | GoActor | SystemActor, Field(discriminator="kind")]
    """
    Who did it: a person, Go, or go-server itself (system).
    """
    text: str | None
    attachments: Annotated[
        list[Annotated[PhotoAttachment | FileAttachment, Field(discriminator="kind")]],
        Field(max_length=10),
    ]
    reply_to: Annotated[str | None, Field(max_length=64, min_length=1)] = None
    about_message_id: Annotated[str | None, Field(max_length=64, min_length=1)] = None
    mentions_go: bool
    mentions: Annotated[list[str], Field(max_length=30)]
    reactions: Annotated[list[Reaction], Field(max_length=100)]
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
        | NoticeCard
        | None,
        Field(discriminator="kind"),
    ] = None
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
    text: Annotated[str | None, Field(max_length=2000, min_length=1)] = None
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
        | NoticeCard
        | None,
        Field(discriminator="kind"),
    ] = None
    reply_to: Annotated[str | None, Field(max_length=64, min_length=1)] = None
    mentions: Annotated[list[str] | None, Field(max_length=30)] = None


class PostMessageResult(BaseModel):
    message_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]


class PutCardResult(BaseModel):
    message_id: Annotated[str, Field(max_length=64, min_length=1)]


class SetTyping(BaseModel):
    on: bool


class DecisionOption(BaseModel):
    label: Annotated[str, Field(max_length=120, min_length=1)]
    image_url: AnyUrl | None = None
    price_minor: Annotated[int | None, Field(ge=0)] = None
    currency: Annotated[str | None, Field(pattern="^[A-Z]{3}$")] = None
    option_ref: Annotated[str | None, Field(max_length=200)] = None
    note: Annotated[str | None, Field(max_length=120)] = None


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
    opened_by_person_id: str | None
    options: Annotated[list[DecisionOption], Field(max_length=10, min_length=2)]
    closes_at: AwareDatetime | None = None
    voted: Annotated[int, Field(ge=0)]
    of: Annotated[int, Field(ge=0)]
    tally: Annotated[list[int], Field(max_length=10)]
    votes: Annotated[list[Vote] | None, Field(max_length=30)] = None
    result_index: Annotated[int | None, Field(ge=0)] = None
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
    image_url: AnyUrl | None = None
    decision_id: Annotated[str | None, Field(max_length=64, min_length=1)] = None
    approval_id: Annotated[str | None, Field(max_length=64, min_length=1)] = None
    added_by_person_id: str | None
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
    booking_id: Annotated[str | None, Field(max_length=64, min_length=1)] = None
    added_by_person_id: str | None
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
    plan_minor: Annotated[int | None, Field(ge=0)] = None
    spent_minor: Annotated[int, Field(ge=0)]
    by_category: Annotated[list[ByCategoryItem], Field(max_length=5)]
    transfers: Annotated[list[Transfer], Field(max_length=60)]


class ItineraryItem(BaseModel):
    item_id: Annotated[str | None, Field(max_length=64, min_length=1)] = None
    time: Annotated[str | None, Field(pattern="^([01]\\d|2[0-3]):[0-5]\\d$")] = None
    title: Annotated[str, Field(max_length=120, min_length=1)]
    category: Literal["stay", "food", "getting_around", "activities", "other"]
    """
    The spending category. The app colours: stay blue, food orange, getting around green, activities yellow.
    """
    place: Place | None = None
    booking_id: Annotated[str | None, Field(max_length=64, min_length=1)] = None
    status: Literal["booked", "planned", "idea"]
    note: Annotated[str | None, Field(max_length=200)] = None


class Day(BaseModel):
    date: date_aliased
    title: Annotated[str | None, Field(max_length=80)] = None
    items: Annotated[list[ItineraryItem], Field(max_length=20)]


class Proof(BaseModel):
    message_id: Annotated[str, Field(max_length=64, min_length=1)]
    person_id: Annotated[str | None, Field(max_length=64, min_length=1)] = None


class RecordLine(BaseModel):
    line_id: Annotated[str, Field(max_length=64, min_length=1)]
    kind: Literal["decided", "agreed", "open", "doing", "booked"]
    text: Annotated[str, Field(max_length=200, min_length=1)]
    status: Literal["active", "done", "undone"]
    proof: Annotated[list[Proof], Field(max_length=10)]
    person_ids: Annotated[list[str], Field(max_length=30)]
    due_at: AwareDatetime | None = None
    decision_id: Annotated[str | None, Field(max_length=64, min_length=1)] = None
    booking_id: Annotated[str | None, Field(max_length=64, min_length=1)] = None
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
    invite_url: AnyUrl
    destination: Place | None = None
    dates: Dates | None = None
    vibe: Annotated[list[str], Field(max_length=12)]
    stay: Annotated[str | None, Field(max_length=60)] = None
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
    Who did it: a person, Go, or go-server itself (system).
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
    Who did it: a person, Go, or go-server itself (system).
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
    person_id: Annotated[str | None, Field(max_length=64, min_length=1)] = None
    option_index: Annotated[int | None, Field(ge=0)] = None
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
    Who did it: a person, Go, or go-server itself (system).
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
    Who did it: a person, Go, or go-server itself (system).
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
    Who did it: a person, Go, or go-server itself (system).
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
    Who did it: a person, Go, or go-server itself (system).
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


class WriteResult(BaseModel):
    seq: Annotated[int, Field(gt=0)]


class UpdateTrip(BaseModel):
    """
    Only the fields sent change.
    """

    request_id: Annotated[str, Field(max_length=64, min_length=1)]
    title: Annotated[str | None, Field(max_length=80, min_length=1)] = None
    destination: Place | None = None
    dates: Dates | None = None
    vibe: Annotated[list[str] | None, Field(max_length=12)] = None
    stay: Annotated[str | None, Field(max_length=60)] = None
    itinerary: Annotated[list[Day] | None, Field(max_length=30)] = None


class OpenDecision(BaseModel):
    """
    Opens a vote. Go then posts a message with a vote card to show it in the room.
    """

    request_id: Annotated[str, Field(max_length=64, min_length=1)]
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


class CloseDecisionResult(BaseModel):
    decision: Decision
    seq: Annotated[int, Field(gt=0)]


class SetMandate(BaseModel):
    """
    Sets (or replaces) what the group allowed for a closed choice vote. Replacing clears the payer's earlier yes or no.
    """

    request_id: Annotated[str, Field(max_length=64, min_length=1)]
    choice_index: Annotated[int, Field(ge=0)]
    cap_minor: Annotated[int, Field(ge=0)]
    currency: Annotated[str, Field(pattern="^[A-Z]{3}$")]
    refundable_only: bool
    payer_person_id: Annotated[str, Field(max_length=64, min_length=1)]


class AddRecordLine(BaseModel):
    request_id: Annotated[str, Field(max_length=64, min_length=1)]
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
    kind: Literal["agreed", "open", "doing"] | None = None
    text: Annotated[str | None, Field(max_length=200, min_length=1)] = None
    status: Literal["active", "done"] | None = None
    proof: Annotated[list[Proof] | None, Field(max_length=10)] = None
    person_ids: Annotated[list[str] | None, Field(max_length=30)] = None
    due_at: AwareDatetime | None = None


class AddBooking(BaseModel):
    request_id: Annotated[str, Field(max_length=64, min_length=1)]
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
    image_url: AnyUrl | None = None
    decision_id: Annotated[str | None, Field(max_length=64, min_length=1)] = None
    approval_id: Annotated[str | None, Field(max_length=64, min_length=1)] = None


class AddBookingResult(BaseModel):
    booking_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]


class UpdateBooking(BaseModel):
    """
    Only the fields sent change.
    """

    request_id: Annotated[str, Field(max_length=64, min_length=1)]
    status: Literal["cancelled"] | None = None
    ref: Annotated[str | None, Field(max_length=80, min_length=1)] = None
    refundable_until: AwareDatetime | None = None
    starts_at: AwareDatetime | None = None
    ends_at: AwareDatetime | None = None


class AddExpense(BaseModel):
    request_id: Annotated[str, Field(max_length=64, min_length=1)]
    paid_by_person_id: Annotated[str, Field(max_length=64, min_length=1)]
    amount_minor: Annotated[int, Field(ge=0)]
    currency: Annotated[str, Field(pattern="^[A-Z]{3}$")]
    note: Annotated[str, Field(max_length=120, min_length=1)]
    category: Literal["stay", "food", "getting_around", "activities", "other"]
    """
    The spending category. The app colours: stay blue, food orange, getting around green, activities yellow.
    """
    split_person_ids: Annotated[list[str], Field(max_length=30, min_length=1)]
    booking_id: Annotated[str | None, Field(max_length=64, min_length=1)] = None


class AddExpenseResult(BaseModel):
    expense_id: Annotated[str, Field(max_length=64, min_length=1)]
    seq: Annotated[int, Field(gt=0)]


class RequestSpendApproval(BaseModel):
    request_id: Annotated[str, Field(max_length=64, min_length=1)]
    decision_id: Annotated[str, Field(max_length=64, min_length=1)]
    amount_minor: Annotated[int, Field(ge=0)]
    currency: Annotated[str, Field(pattern="^[A-Z]{3}$")]
    merchant: Annotated[str, Field(max_length=120, min_length=1)]
    purpose: Annotated[str, Field(max_length=200, min_length=1)]
    refundable_until: AwareDatetime | None = None


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
    detail: Annotated[str | None, Field(max_length=200)] = None


class SpendApprovalResult(RootModel[SpendApproved | SpendDenied]):
    root: Annotated[SpendApproved | SpendDenied, Field(discriminator="status")]


class EventAccepted(BaseModel):
    accepted: Literal[True]
    duplicate: bool


class CardActionRequest(BaseModel):
    action_id: Annotated[str, Field(pattern="^[a-z][a-z_]{0,31}$")]
    person_id: Annotated[str, Field(max_length=64, min_length=1)]
    option_id: Annotated[str | None, Field(max_length=64, min_length=1)] = None


class ActionDone(BaseModel):
    result: Literal["done"]
    toast: Annotated[str | None, Field(max_length=120)] = None


class ActionOpen(BaseModel):
    result: Literal["open"]
    url: AnyUrl
    expires_at: AwareDatetime


class ActionRefused(BaseModel):
    result: Literal["refused"]
    toast: Annotated[str, Field(max_length=120, min_length=1)]


class CardActionResult(RootModel[ActionDone | ActionOpen | ActionRefused]):
    root: Annotated[
        ActionDone | ActionOpen | ActionRefused, Field(discriminator="result")
    ]


class CatchUpRequest(BaseModel):
    person_id: Annotated[str, Field(max_length=64, min_length=1)]
    since: AwareDatetime


class Item(BaseModel):
    kind: Literal["decided", "booked", "needs_you", "open", "news"]
    text: Annotated[str, Field(max_length=140, min_length=1)]
    image_url: AnyUrl | None = None
    message_id: Annotated[str | None, Field(max_length=64, min_length=1)] = None


class CatchUp(BaseModel):
    """
    For one person only. Shown above the room, never posted in it.
    """

    summary: str | None
    items: Annotated[list[Item], Field(max_length=5)]


class Fact(BaseModel):
    fact_id: Annotated[str, Field(max_length=64, min_length=1)]
    topic: Annotated[str, Field(max_length=40, min_length=1)]
    text: Annotated[str, Field(max_length=200, min_length=1)]
    audience: Literal["group", "only_go"]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    message_id: str | None
    said_at: AwareDatetime


class PersonPage(BaseModel):
    person_id: Annotated[str, Field(max_length=64, min_length=1)]
    carry_over: bool
    facts: Annotated[list[Fact], Field(max_length=500)]


class UpdatePerson(BaseModel):
    carry_over: bool


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
    url: AnyUrl
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


class SpendApprovalClaims(BaseModel):
    """
    What go-server signs. exp is at most 600 seconds after iat.
    """

    iss: Literal["go-server"]
    aud: Literal["go-brain-vault"]
    jti: Annotated[str, Field(max_length=64, min_length=8)]
    trip_id: Annotated[str, Field(max_length=64, min_length=1)]
    decision_id: Annotated[str, Field(max_length=64, min_length=1)]
    payer_person_id: Annotated[str, Field(max_length=64, min_length=1)]
    amount_minor: Annotated[int, Field(ge=0)]
    currency: Annotated[str, Field(pattern="^[A-Z]{3}$")]
    merchant: Annotated[str, Field(max_length=120, min_length=1)]
    purpose: Annotated[str, Field(max_length=200, min_length=1)]
    refundable_until: AwareDatetime | None = None
    iat: Annotated[int, Field(ge=-9007199254740991)]
    exp: Annotated[int, Field(ge=-9007199254740991)]
