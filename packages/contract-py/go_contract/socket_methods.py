# Generated from packages/contract/socket/methods.json by scripts/gen_models.py. Do not edit.
"""Every socket method: who sends it, its params model and its result model (None for a notification)."""

from typing import NamedTuple

from . import models


class Method(NamedTuple):
    name: str
    direction: str  # to_brain: go-server sends it. to_server: Go sends it and go-server answers.
    params: type
    result: type | None
    answer_within_seconds: int | None
    sends_event: str | None


PATH = '/v1/socket'
METHODS: dict[str, Method] = {
    'send_event': Method('send_event', 'to_brain', models.Event, models.EventAccepted, 2, None),
    'person_typing': Method('person_typing', 'to_brain', models.PersonTyping, None, None, None),
    'card_tap': Method('card_tap', 'to_brain', models.CardTap, models.CardActionResult, 3, None),
    'catch_up': Method('catch_up', 'to_brain', models.CatchUpRequest, models.CatchUp, 3, None),
    'get_person': Method('get_person', 'to_brain', models.GetPerson, models.PersonPage, 2, None),
    'update_person': Method('update_person', 'to_brain', models.UpdatePerson, models.Ok, 2, None),
    'delete_fact': Method('delete_fact', 'to_brain', models.DeleteFact, models.Ok, 2, None),
    'forget_person': Method('forget_person', 'to_brain', models.ForgetPerson, models.ForgetResult, 2, None),
    'vault_link': Method('vault_link', 'to_brain', models.CreateLink, models.Link, 2, None),
    'read_trip': Method('read_trip', 'to_server', models.ReadTrip, models.TripSnapshot, 2, None),
    'read_messages': Method('read_messages', 'to_server', models.ReadMessages, models.MessagesPage, 2, None),
    'post_message': Method('post_message', 'to_server', models.PostMessage, models.PostMessageResult, 2, 'message.created'),
    'replace_card': Method('replace_card', 'to_server', models.ReplaceCard, models.ReplaceCardResult, 2, None),
    'typing': Method('typing', 'to_server', models.GoTyping, None, None, None),
    'add_reaction': Method('add_reaction', 'to_server', models.AddReaction, models.WriteResult, 2, 'reaction.added'),
    'remove_reaction': Method('remove_reaction', 'to_server', models.RemoveReaction, models.WriteResult, 2, 'reaction.removed'),
    'update_trip': Method('update_trip', 'to_server', models.UpdateTrip, models.WriteResult, 2, 'trip.updated'),
    'open_vote': Method('open_vote', 'to_server', models.OpenDecision, models.OpenDecisionResult, 2, 'decision.opened'),
    'close_vote': Method('close_vote', 'to_server', models.CloseDecision, models.CloseDecisionResult, 2, 'decision.closed'),
    'set_mandate': Method('set_mandate', 'to_server', models.SetMandate, models.WriteResult, 2, 'mandate.set'),
    'add_record_line': Method('add_record_line', 'to_server', models.AddRecordLine, models.AddRecordLineResult, 2, 'record.changed'),
    'update_record_line': Method('update_record_line', 'to_server', models.UpdateRecordLine, models.WriteResult, 2, 'record.changed'),
    'add_booking': Method('add_booking', 'to_server', models.AddBooking, models.AddBookingResult, 2, 'booking.changed'),
    'update_booking': Method('update_booking', 'to_server', models.UpdateBooking, models.WriteResult, 2, 'booking.changed'),
    'add_expense': Method('add_expense', 'to_server', models.AddExpense, models.AddExpenseResult, 2, 'expense.changed'),
    'request_spend_approval': Method('request_spend_approval', 'to_server', models.RequestSpendApproval, models.SpendApprovalResult, 2, None),
    'cancel_spend_approval': Method('cancel_spend_approval', 'to_server', models.CancelSpendApproval, models.Ok, 2, None),
}
