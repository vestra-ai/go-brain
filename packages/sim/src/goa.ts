// The Goa trip from the guide: Rahul, Priya, Arjun, Meher and Kabir plan a long weekend in North Goa.
import type { TripSnapshot } from '@go/contract';

export const GOA_TRIP_ID = 't_goa';

export const GOA_PEOPLE = {
  rahul: 'p_rahul',
  priya: 'p_priya',
  arjun: 'p_arjun',
  meher: 'p_meher',
  kabir: 'p_kabir',
} as const;

/** The trip in the middle of planning, at change 113: the read_trip example in docs/guide/04-gos-requests.md. */
export const GOA_SNAPSHOT: TripSnapshot = {
  "trip_id": "t_goa",
  "seq": 113,
  "title": "Goa 🌴",
  "status": "planning",
  "created_at": "2026-10-05T02:30:00Z",
  "organizer_person_id": "p_rahul",
  "invite_url": "https://go.example/j/8fK2xQ",
  "destination": {
    "name": "North Goa",
    "lat": 15.6,
    "lng": 73.75,
    "photo_url": "https://brain.go.example/img/north-goa.jpg"
  },
  "dates": {
    "start": "2026-11-06",
    "end": "2026-11-09"
  },
  "vibe": [
    "beaches",
    "food",
    "sunsets"
  ],
  "stay": "villa with a pool",
  "budget": {
    "lowest": {
      "min_minor": 1000000,
      "max_minor": 1500000,
      "currency": "INR"
    },
    "answered": 4,
    "of": 5
  },
  "people": [
    {
      "person_id": "p_rahul",
      "name": "Rahul",
      "photo_url": "https://cdn.go.example/people/p_rahul.jpg",
      "role": "organizer",
      "joined_at": "2026-10-05T02:30:00Z",
      "from_city": "Delhi",
      "earliest_leave": "Fri after 6 pm",
      "know": [],
      "has_upi": true,
      "go_paused": false
    },
    {
      "person_id": "p_priya",
      "name": "Priya",
      "photo_url": "https://cdn.go.example/people/p_priya.jpg",
      "role": "member",
      "joined_at": "2026-10-05T02:48:00Z",
      "from_city": "Delhi",
      "know": [
        "Vegetarian",
        "Window seat"
      ],
      "has_upi": false,
      "go_paused": false
    },
    {
      "person_id": "p_arjun",
      "name": "Arjun",
      "photo_url": "https://cdn.go.example/people/p_arjun.jpg",
      "role": "member",
      "joined_at": "2026-10-05T03:02:00Z",
      "from_city": "Bangalore",
      "know": [
        "No early flights",
        "Lands late on Friday"
      ],
      "has_upi": false,
      "go_paused": false
    },
    {
      "person_id": "p_meher",
      "name": "Meher",
      "photo_url": "https://cdn.go.example/people/p_meher.jpg",
      "role": "member",
      "joined_at": "2026-10-05T03:15:00Z",
      "from_city": "Mumbai",
      "know": [
        "Birthday on 7 Nov"
      ],
      "has_upi": false,
      "go_paused": false
    },
    {
      "person_id": "p_kabir",
      "name": "Kabir",
      "photo_url": "https://cdn.go.example/people/p_kabir.jpg",
      "role": "member",
      "joined_at": "2026-10-05T03:40:00Z",
      "from_city": "Delhi",
      "earliest_leave": "Fri evening",
      "know": [
        "I don't drink"
      ],
      "has_upi": true,
      "go_paused": false
    }
  ],
  "decisions": [
    {
      "decision_id": "d_when",
      "question": "When do we go?",
      "kind": "choice",
      "anonymous": false,
      "status": "closed",
      "options": [
        {
          "label": "30 Oct to 2 Nov"
        },
        {
          "label": "6 to 9 Nov",
          "note": "Diwali long weekend"
        },
        {
          "label": "13 to 16 Nov"
        }
      ],
      "voted": 4,
      "of": 5,
      "tally": [
        0,
        4,
        0
      ],
      "votes": [
        {
          "person_id": "p_rahul",
          "option_index": 1
        },
        {
          "person_id": "p_priya",
          "option_index": 1
        },
        {
          "person_id": "p_arjun",
          "option_index": 1
        },
        {
          "person_id": "p_meher",
          "option_index": 1
        }
      ],
      "result_index": 1,
      "opened_at": "2026-10-05T02:30:30Z",
      "closed_at": "2026-10-05T03:45:00Z"
    },
    {
      "decision_id": "d_villa",
      "question": "Where do we stay?",
      "kind": "choice",
      "anonymous": false,
      "status": "closed",
      "options": [
        {
          "label": "Villa Sol",
          "image_url": "https://brain.go.example/img/villa-sol.jpg",
          "price_minor": 5420000,
          "currency": "INR",
          "option_ref": "ixigo:stay:villa-sol-anjuna",
          "note": "3 nights, private pool, Anjuna"
        },
        {
          "label": "Casa Azul",
          "image_url": "https://brain.go.example/img/casa-azul.jpg",
          "price_minor": 6180000,
          "currency": "INR",
          "option_ref": "ixigo:stay:casa-azul-assagao",
          "note": "3 nights, pool, Assagao"
        },
        {
          "label": "The Palms",
          "image_url": "https://brain.go.example/img/the-palms.jpg",
          "price_minor": 5850000,
          "currency": "INR",
          "option_ref": "ixigo:stay:the-palms-vagator",
          "note": "3 nights, pool, near Vagator beach"
        }
      ],
      "closes_at": "2026-10-05T12:30:00Z",
      "voted": 5,
      "of": 5,
      "tally": [
        4,
        1,
        0
      ],
      "votes": [
        {
          "person_id": "p_rahul",
          "option_index": 0
        },
        {
          "person_id": "p_arjun",
          "option_index": 1
        },
        {
          "person_id": "p_priya",
          "option_index": 0
        },
        {
          "person_id": "p_meher",
          "option_index": 0
        },
        {
          "person_id": "p_kabir",
          "option_index": 0
        }
      ],
      "result_index": 0,
      "mandate": {
        "choice_index": 0,
        "cap_minor": 5500000,
        "currency": "INR",
        "refundable_only": true,
        "payer_person_id": "p_rahul",
        "set_at": "2026-10-05T08:46:00Z",
        "confirmed_at": "2026-10-05T08:58:00Z"
      },
      "opened_at": "2026-10-05T07:30:00Z",
      "closed_at": "2026-10-05T08:45:00Z"
    },
    {
      "decision_id": "d_beach",
      "question": "Which beach on Sunday?",
      "kind": "choice",
      "anonymous": false,
      "status": "cancelled",
      "opened_by_person_id": "p_rahul",
      "options": [
        {
          "label": "Ashwem"
        },
        {
          "label": "Morjim"
        }
      ],
      "voted": 2,
      "of": 5,
      "tally": [
        1,
        1
      ],
      "votes": [
        {
          "person_id": "p_rahul",
          "option_index": 0
        },
        {
          "person_id": "p_meher",
          "option_index": 1
        }
      ],
      "opened_at": "2026-10-06T09:40:00Z"
    }
  ],
  "bookings": [
    {
      "booking_id": "b_villa",
      "kind": "stay",
      "status": "confirmed",
      "title": "Villa Sol, 3 nights",
      "vendor": "ixigo",
      "ref": "IXG-7Q2K9",
      "amount_minor": 5420000,
      "currency": "INR",
      "payer_person_id": "p_rahul",
      "for_person_ids": [
        "p_rahul",
        "p_priya",
        "p_arjun",
        "p_meher",
        "p_kabir"
      ],
      "refundable_until": "2026-11-01T18:29:59Z",
      "starts_at": "2026-11-06T14:00:00+05:30",
      "ends_at": "2026-11-09T11:00:00+05:30",
      "place": {
        "name": "Villa Sol",
        "address": "Anjuna, North Goa",
        "photo_url": "https://brain.go.example/img/villa-sol.jpg"
      },
      "image_url": "https://brain.go.example/img/villa-sol.jpg",
      "decision_id": "d_villa",
      "approval_id": "ap_01JA7Q3V8Z",
      "created_at": "2026-10-05T09:03:00Z"
    }
  ],
  "expenses": [
    {
      "expense_id": "e_villa",
      "paid_by_person_id": "p_rahul",
      "amount_minor": 5420000,
      "currency": "INR",
      "note": "Villa Sol, 3 nights",
      "category": "stay",
      "split_person_ids": [
        "p_rahul",
        "p_priya",
        "p_arjun",
        "p_meher",
        "p_kabir"
      ],
      "booking_id": "b_villa",
      "created_at": "2026-10-05T09:03:20Z"
    },
    {
      "expense_id": "e_cab",
      "paid_by_person_id": "p_kabir",
      "amount_minor": 340000,
      "currency": "INR",
      "note": "Airport cab",
      "category": "getting_around",
      "split_person_ids": [
        "p_rahul",
        "p_priya",
        "p_arjun",
        "p_meher",
        "p_kabir"
      ],
      "added_by_person_id": "p_kabir",
      "created_at": "2026-10-09T13:20:00Z"
    }
  ],
  "money": {
    "currency": "INR",
    "plan_minor": 7500000,
    "spent_minor": 5760000,
    "by_category": [
      {
        "category": "stay",
        "amount_minor": 5420000
      },
      {
        "category": "getting_around",
        "amount_minor": 340000
      }
    ],
    "transfers": [
      {
        "from_person_id": "p_priya",
        "to_person_id": "p_rahul",
        "amount_minor": 1152000,
        "currency": "INR"
      },
      {
        "from_person_id": "p_arjun",
        "to_person_id": "p_rahul",
        "amount_minor": 1152000,
        "currency": "INR"
      },
      {
        "from_person_id": "p_meher",
        "to_person_id": "p_rahul",
        "amount_minor": 1152000,
        "currency": "INR"
      },
      {
        "from_person_id": "p_kabir",
        "to_person_id": "p_rahul",
        "amount_minor": 812000,
        "currency": "INR"
      }
    ]
  },
  "itinerary": [
    {
      "date": "2026-11-06",
      "title": "Arrive",
      "items": [
        {
          "item_id": "i_land",
          "time": "20:45",
          "title": "Land in Goa on IndiGo 6E 2134",
          "category": "getting_around",
          "status": "planned",
          "note": "Rahul, Priya and Kabir from Delhi. Flights not booked yet."
        },
        {
          "item_id": "i_cab",
          "time": "21:15",
          "title": "Airport cab to Villa Sol",
          "category": "getting_around",
          "status": "booked",
          "note": "Kabir booked it"
        },
        {
          "item_id": "i_checkin",
          "time": "22:30",
          "title": "Check in at Villa Sol",
          "category": "stay",
          "place": {
            "name": "Villa Sol",
            "address": "Anjuna, North Goa"
          },
          "booking_id": "b_villa",
          "status": "booked",
          "note": "Arjun checks in at 11 pm. Mohan, the caretaker, meets him."
        }
      ]
    },
    {
      "date": "2026-11-07",
      "title": "Meher's birthday",
      "items": [
        {
          "item_id": "i_brunch",
          "time": "11:00",
          "title": "Brunch at Artjuna",
          "category": "food",
          "place": {
            "name": "Artjuna",
            "address": "Anjuna, North Goa"
          },
          "status": "idea"
        },
        {
          "item_id": "i_sunset",
          "time": "17:30",
          "title": "Sunset at Chapora Fort",
          "category": "activities",
          "place": {
            "name": "Chapora Fort",
            "address": "Chapora, North Goa"
          },
          "status": "planned"
        },
        {
          "item_id": "i_dinner",
          "time": "20:30",
          "title": "Birthday dinner at Thalassa",
          "category": "food",
          "place": {
            "name": "Thalassa",
            "address": "Siolim, North Goa"
          },
          "status": "idea",
          "note": "Plenty for Priya (vegetarian)"
        }
      ]
    }
  ],
  "record": [
    {
      "line_id": "r_dates",
      "kind": "decided",
      "text": "6 to 9 Nov",
      "status": "active",
      "proof": [],
      "person_ids": [],
      "decision_id": "d_when",
      "source": "vote",
      "created_at": "2026-10-05T03:45:00Z",
      "updated_at": "2026-10-05T03:45:00Z"
    },
    {
      "line_id": "r_north",
      "kind": "agreed",
      "text": "North Goa, not South",
      "status": "active",
      "proof": [
        {
          "message_id": "m_0122",
          "person_id": "p_priya"
        },
        {
          "message_id": "m_0124",
          "person_id": "p_arjun"
        }
      ],
      "person_ids": [
        "p_priya",
        "p_arjun",
        "p_rahul"
      ],
      "source": "go",
      "created_at": "2026-10-05T04:14:00Z",
      "updated_at": "2026-10-05T04:14:00Z"
    },
    {
      "line_id": "r_scuba",
      "kind": "open",
      "text": "Scuba on Saturday?",
      "status": "active",
      "proof": [
        {
          "message_id": "m_0149",
          "person_id": "p_arjun"
        }
      ],
      "person_ids": [
        "p_meher",
        "p_kabir"
      ],
      "source": "go",
      "created_at": "2026-10-05T07:20:00Z",
      "updated_at": "2026-10-05T07:20:00Z"
    },
    {
      "line_id": "r_villa",
      "kind": "booked",
      "text": "Villa Sol, 3 nights",
      "status": "active",
      "proof": [],
      "person_ids": [],
      "decision_id": "d_villa",
      "booking_id": "b_villa",
      "source": "booking",
      "created_at": "2026-10-05T08:45:00Z",
      "updated_at": "2026-10-05T09:03:00Z"
    },
    {
      "line_id": "r_cab",
      "kind": "doing",
      "text": "Kabir books the airport cab",
      "status": "done",
      "proof": [
        {
          "message_id": "m_0192",
          "person_id": "p_kabir"
        }
      ],
      "person_ids": [
        "p_kabir"
      ],
      "source": "go",
      "created_at": "2026-10-05T11:05:00Z",
      "updated_at": "2026-10-09T13:20:30Z"
    },
    {
      "line_id": "r_deposit",
      "kind": "open",
      "text": "₹2,000 off at Villa Sol if we pay the deposit this week?",
      "status": "active",
      "proof": [
        {
          "message_id": "m_0174"
        }
      ],
      "person_ids": [
        "p_rahul"
      ],
      "due_at": "2026-10-11T18:29:59Z",
      "source": "go",
      "created_at": "2026-10-06T10:36:00Z",
      "updated_at": "2026-10-06T10:36:00Z"
    }
  ]
};

/** The same five people at the very start of the trip, as trip.created (change 1) carries it. A new copy each call. */
export function goaFreshTrip(): TripSnapshot {
  const s = structuredClone(GOA_SNAPSHOT);
  return {
    ...s,
    seq: 1,
    destination: { name: 'Goa' },
    dates: null,
    budget: { lowest: null, answered: 0, of: s.people.length },
    decisions: [],
    bookings: [],
    expenses: [],
    money: { currency: 'INR', plan_minor: null, spent_minor: 0, by_category: [], transfers: [] },
    itinerary: [],
    record: [],
  };
}

/** A few lines of chat to start a room with. Only the last one is for Go. */
export const GOA_SEED_CHAT: ReadonlyArray<{ personId: string; text: string }> = [
  { personId: GOA_PEOPLE.rahul, text: 'Goa for the Diwali long weekend? 6 to 9 Nov' },
  { personId: GOA_PEOPLE.priya, text: "Let's do North Goa, not South. Better beaches for us." },
  { personId: GOA_PEOPLE.arjun, text: "Yes, North. It's closer to the airport for my late flight too." },
  { personId: GOA_PEOPLE.priya, text: "I'm veg btw" },
  { personId: GOA_PEOPLE.kabir, text: 'haha Arjun always lands late 😂' },
  { personId: GOA_PEOPLE.priya, text: '@Go flights on Friday from Delhi, under 6k?' },
];
