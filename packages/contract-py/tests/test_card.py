from go_contract import Card, models


def test_card_picks_the_kind():
    card = Card.model_validate_json(
        '{"card_id": "c_villa_ticket", "kind": "ticket", "booking_id": "b_villa", "fallback_text": "Villa Sol is booked."}'
    ).root
    assert isinstance(card, models.TicketCard)
    assert card.booking_id == "b_villa"


def test_card_refuses_an_unknown_kind():
    try:
        Card.model_validate_json('{"card_id": "c_1", "kind": "confetti", "fallback_text": "x"}')
    except ValueError:
        return
    raise AssertionError("an unknown kind should not validate")
