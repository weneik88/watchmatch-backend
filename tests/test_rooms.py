import pytest

from rooms import (Bucket, Member, Room, RoomFull, Rooms, TooManyRooms, clean_name,
                   clean_text, parse_source)

T0 = 1_000_000


def make_room(n=2, max_members=12):
    room = Room("test-room", max_members)
    members = []
    for i in range(n):
        m = Member(id=f"m{i}", name=f"User{i}")
        room.add_member(m, T0 + i)
        members.append(m)
    return room, members


def kinds(outs):
    return [o.payload["t"] for o in outs]


# --- sources -----------------------------------------------------------------

@pytest.mark.parametrize("url,vid", [
    ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
    ("https://youtu.be/dQw4w9WgXcQ?t=10", "dQw4w9WgXcQ"),
    ("https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share", "dQw4w9WgXcQ"),
    ("https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
    ("https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
    ("  https://youtube.com/live/dQw4w9WgXcQ  ", "dQw4w9WgXcQ"),
])
def test_youtube_links(url, vid):
    src = parse_source(url)
    assert src["kind"] == "youtube" and src["id"] == vid


@pytest.mark.parametrize("url", [
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/",
    "javascript:alert(1)",
    "ftp://example.com/a.mp4",
    "file:///etc/passwd",
    "not a url",
    "",
    None,
    123,
    "https://example.com/" + "a" * 2100,
    "https://example.com/a\x00.mp4",
])
def test_bad_links(url):
    assert parse_source(url) is None


def test_file_link():
    assert parse_source("https://cdn.example.com/movie.mp4") == {
        "kind": "file", "url": "https://cdn.example.com/movie.mp4"}


# --- sanitising ---------------------------------------------------------------

def test_clean_text():
    assert clean_text("  hi \n\t there\x00 ", 50) == "hi there"
    assert clean_text("x" * 500, 300) == "x" * 300
    assert clean_text(None, 10) == ""
    assert clean_text("a‮b", 10) == "ab"  # bidi override stripped


def test_clean_name_default():
    assert clean_name("   ", "Гость-1") == "Гость-1"
    assert clean_name("Аня", "x") == "Аня"


# --- membership -----------------------------------------------------------------

def test_first_member_is_host_and_welcome_has_state():
    room = Room("r")
    outs = room.add_member(Member(id="a", name="A"), T0)
    assert room.host_id == "a"
    welcome = outs[0]
    assert welcome.to == "a" and welcome.payload["t"] == "welcome"
    assert welcome.payload["you"] == "a" and welcome.payload["state"]["src"] is None


def test_room_full():
    room, _ = make_room(2, max_members=2)
    with pytest.raises(RoomFull):
        room.add_member(Member(id="x", name="X"), T0 + 10)


def test_host_leaves_oldest_member_takes_over():
    room, (a, b, c) = make_room(3)
    outs = room.remove_member("m0", T0 + 100)
    assert room.host_id == "m1"
    leave = outs[0].payload
    assert leave["t"] == "leave" and leave["newHost"] == "m1"
    assert room.members_message()["host"] == "m1"


def test_non_host_leaves_keeps_host():
    room, _ = make_room(3)
    outs = room.remove_member("m2", T0 + 100)
    assert room.host_id == "m0" and outs[0].payload["newHost"] is None


def test_remove_unknown_is_noop():
    room, _ = make_room(1)
    assert room.remove_member("ghost", T0) == []


def test_late_joiner_gets_current_state_and_chat():
    room, _ = make_room(2)
    room.handle("m0", {"t": "load", "url": "https://youtu.be/dQw4w9WgXcQ"}, T0 + 1000)
    room.handle("m0", {"t": "play", "pos": 10}, T0 + 1000)
    room.handle("m1", {"t": "chat", "text": "привет"}, T0 + 2000)
    outs = room.add_member(Member(id="late", name="Late"), T0 + 6000)
    welcome = outs[0].payload
    assert welcome["state"]["playing"] is True
    assert welcome["chat"][0]["text"] == "привет"
    # 5 seconds after play at pos 10 -> the position a newcomer should seek to
    assert room.position(T0 + 6000) == pytest.approx(15.0)


# --- permissions ---------------------------------------------------------------------

def test_non_host_cannot_control_until_opened():
    room, _ = make_room(2)
    outs = room.handle("m1", {"t": "load", "url": "https://youtu.be/dQw4w9WgXcQ"}, T0 + 10)
    assert outs[0].payload["code"] == "forbidden" and room.state["src"] is None

    room.handle("m0", {"t": "control", "open": True}, T0 + 20)
    outs = room.handle("m1", {"t": "load", "url": "https://youtu.be/dQw4w9WgXcQ"}, T0 + 30)
    assert outs[0].payload["t"] == "state" and room.state["src"]["id"] == "dQw4w9WgXcQ"


def test_only_host_can_open_control_or_transfer():
    room, _ = make_room(2)
    assert room.handle("m1", {"t": "control", "open": True}, T0)[0].payload["code"] == "forbidden"
    assert room.handle("m1", {"t": "host", "to": "m1"}, T0)[0].payload["code"] == "forbidden"
    assert room.open_control is False and room.host_id == "m0"


def test_host_transfer():
    room, _ = make_room(2)
    outs = room.handle("m0", {"t": "host", "to": "m1"}, T0)
    assert room.host_id == "m1" and "hostchanged" in kinds(outs)
    assert room.handle("m1", {"t": "host", "to": "ghost"}, T0 + 1) == []  # m1 is host now


# --- playback -------------------------------------------------------------------------

def loaded_room():
    room, _ = make_room(2)
    room.handle("m0", {"t": "load", "url": "https://youtu.be/dQw4w9WgXcQ"}, T0)
    return room


def test_play_pause_seek_rate_cycle():
    room = loaded_room()
    room.handle("m0", {"t": "play", "pos": 5}, T0 + 1000)
    assert room.position(T0 + 4000) == pytest.approx(8.0)

    room.handle("m0", {"t": "pause"}, T0 + 4000)  # pos defaults to the computed one
    assert room.state["playing"] is False and room.state["pos"] == pytest.approx(8.0)
    assert room.position(T0 + 99999) == pytest.approx(8.0)

    room.handle("m0", {"t": "seek", "pos": 100}, T0 + 5000)
    assert room.state["pos"] == 100

    room.handle("m0", {"t": "play"}, T0 + 6000)
    room.handle("m0", {"t": "rate", "rate": 2}, T0 + 8000)  # 2s at 1x -> 102, no jump
    assert room.state["pos"] == pytest.approx(102.0) and room.state["rate"] == 2
    assert room.position(T0 + 9000) == pytest.approx(104.0)


def test_play_without_video_is_error():
    room, _ = make_room(1)
    assert room.handle("m0", {"t": "play"}, T0)[0].payload["code"] == "no_video"


def test_bad_numbers_are_rejected():
    room = loaded_room()
    for bad in ("5", None, float("nan"), float("inf"), True, [1]):
        assert room.handle("m0", {"t": "seek", "pos": bad}, T0 + 1) == []
    for bad in (0, 0.1, 3, -1, "2", None, float("inf")):
        assert room.handle("m0", {"t": "rate", "rate": bad}, T0 + 1) == []
    assert room.state["rate"] == 1.0


def test_positions_are_clamped():
    room = loaded_room()
    room.handle("m0", {"t": "seek", "pos": -50}, T0 + 1)
    assert room.state["pos"] == 0
    room.handle("m0", {"t": "seek", "pos": 1e12}, T0 + 2)
    assert room.state["pos"] <= 24 * 3600 * 10


def test_load_bad_url():
    room, _ = make_room(1)
    out = room.handle("m0", {"t": "load", "url": "javascript:alert(1)"}, T0)[0].payload
    assert out["code"] == "bad_url" and room.state["src"] is None


def test_countdown_starts_in_future_and_position_waits():
    room = loaded_room()
    room.handle("m0", {"t": "seek", "pos": 30}, T0 + 100)
    outs = room.handle("m0", {"t": "countdown"}, T0 + 1000)
    msg = outs[0].payload
    assert msg["t"] == "countdown" and msg["startAt"] == T0 + 4000
    assert room.position(T0 + 2000) == pytest.approx(30.0)  # still waiting
    assert room.position(T0 + 6000) == pytest.approx(32.0)  # two seconds after the start


# --- chat / reactions / party / ping ------------------------------------------------

def test_chat_broadcast_history_and_limit():
    room, _ = make_room(2)
    out = room.handle("m0", {"t": "chat", "text": "  привет  "}, T0)[0]
    assert out.to == "all" and out.payload["text"] == "привет" and out.payload["name"] == "User0"
    assert room.handle("m0", {"t": "chat", "text": "   "}, T0) == []
    assert room.handle("m0", {"t": "chat", "text": 5}, T0) == []
    for i in range(80):
        room.members["m0"].buckets["chat"].tokens = 5
        room.members["m0"].buckets["any"].tokens = 40
        room.handle("m0", {"t": "chat", "text": f"msg{i}"}, T0 + i)
    assert len(room.chat) == 50


def test_chat_rate_limit():
    room, _ = make_room(1)
    results = [room.handle("m0", {"t": "chat", "text": f"m{i}"}, T0) for i in range(8)]
    assert kinds(results[0]) == ["chat"]
    assert any(r and r[0].payload.get("code") == "rate" for r in results[5:])


def test_reactions_whitelist_and_variation_selector():
    room, _ = make_room(1)
    assert room.handle("m0", {"t": "react", "emoji": "❤"}, T0)[0].payload["emoji"] == "❤️"
    assert room.handle("m0", {"t": "react", "emoji": "🔥"}, T0)[0].payload["emoji"] == "🔥"
    assert room.handle("m0", {"t": "react", "emoji": "<script>"}, T0) == []
    assert room.handle("m0", {"t": "react", "emoji": 1}, T0) == []


def test_party_kinds_and_cooldown():
    room, _ = make_room(1)
    assert kinds(room.handle("m0", {"t": "party", "kind": "confetti"}, T0)) == ["party"]
    assert room.handle("m0", {"t": "party", "kind": "nuke"}, T0) == []
    room.handle("m0", {"t": "party", "kind": "disco"}, T0)
    assert room.handle("m0", {"t": "party", "kind": "disco"}, T0)[0].payload["code"] == "rate"


def test_rename():
    room, _ = make_room(1)
    outs = room.handle("m0", {"t": "rename", "name": " Новое  имя "}, T0)
    assert room.members["m0"].name == "Новое имя" and kinds(outs) == ["members"]
    assert room.handle("m0", {"t": "rename", "name": ""}, T0) == []


def test_ping_pong():
    room, _ = make_room(1)
    out = room.handle("m0", {"t": "ping", "c": 123.5}, T0 + 7)[0]
    assert out.to == "m0" and out.payload == {"t": "pong", "c": 123.5, "s": T0 + 7}
    assert room.handle("m0", {"t": "ping", "c": "x"}, T0) == []


def test_garbage_messages_ignored():
    room, _ = make_room(1)
    for junk in (None, 5, "str", [], {}, {"t": 5}, {"t": "nope"}, {"t": "__init__"}, {"t": "state"}):
        assert room.handle("m0", junk, T0) == []
    assert room.handle("ghost", {"t": "chat", "text": "x"}, T0) == []


def test_global_flood_is_dropped():
    room, _ = make_room(1)
    sent = sum(1 for i in range(500) if room.handle("m0", {"t": "ping", "c": 1}, T0))
    assert sent <= 45  # bucket capacity is 40, plus a little refill


def test_bucket_refills():
    b = Bucket(2, 1)
    assert b.take(0) and b.take(0) and not b.take(0)
    assert b.take(1.1)


# --- registry --------------------------------------------------------------------------------

def test_registry_limits_and_cleanup():
    rooms = Rooms(max_rooms=2, max_members=3)
    a = rooms.get_or_create("aaa")
    assert rooms.get_or_create("aaa") is a
    rooms.get_or_create("bbb")
    with pytest.raises(TooManyRooms):
        rooms.get_or_create("ccc")
    rooms.discard_if_empty("aaa")
    assert len(rooms) == 1
    rooms.get_or_create("ccc")
    r = rooms.get("bbb")
    r.add_member(Member(id="x", name="X"), T0)
    rooms.discard_if_empty("bbb")
    assert rooms.get("bbb") is r  # not empty -> stays
