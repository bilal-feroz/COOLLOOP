"""Weather integration tests. The Meteomatics API is replaced by an in-process
HTTP transport that speaks the documented URL and JSON formats."""

from datetime import datetime, timedelta, timezone

import httpx
import pytest

from app.config import Settings
from app.facility import Location
from app.store import Store
from app.weather import demo
from app.weather.meteomatics import PARAMETERS, MeteomaticsClient, MeteomaticsError
from app.weather.service import WeatherService

NOW = datetime(2026, 11, 14, 10, 20, tzinfo=timezone.utc)
VALUES = {
    "t_2m:C": 31.0, "wet_bulb_t_2m:C": 23.5, "relative_humidity_2m:p": 52.0,
    "dew_point_2m:C": 20.1, "wind_speed_10m:ms": 4.2, "global_rad:W": 610.0,
    "precip_1h:mm": 0.0, "evaporation_1h:mm": -0.31, "sfc_pressure:hPa": 1012.4,
}  # fmt: skip


class FakeMeteomatics:
    """Minimal stand-in for api.meteomatics.com."""

    def __init__(
        self, missing=(), fail_status=None, raise_exc=None, garbage=False, deny_history=False,
        stats=None, shape=None,
    ):  # fmt: skip
        self.missing = set(missing)
        self.fail_status = fail_status
        self.raise_exc = raise_exc
        self.garbage = garbage
        self.deny_history = deny_history
        self.stats = stats or {}  # extra or replaced fields of the account statistics
        self.shape = shape  # optional (parameter, time) -> value
        self.requests: list[httpx.Request] = []

    @property
    def data_requests(self) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.path != "/user_stats_json"]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.raise_exc:
            raise self.raise_exc
        if self.fail_status:
            return httpx.Response(self.fail_status, json={"message": "simulated failure"})
        if request.url.path == "/user_stats_json":
            return httpx.Response(200, json={"user statistics": {
                "username": "tester",
                "requests since last UTC midnight": {"used": 41, "soft limit": 0, "hard limit": 500},
                "requests in the last 60 seconds": {"used": 2, "soft limit": 0, "hard limit": 15},
                "historic request option": True,
                **self.stats,
            }})  # fmt: skip
        if self.garbage:
            return httpx.Response(200, text="<html>not json</html>")
        when, params, _location, fmt = request.url.path.strip("/").split("/")
        assert fmt == "json"
        if "--" in when:
            span, step = when.rsplit(":", 1)
            assert step == "PT1H"
            start_text, end_text = span.split("--")
        else:
            start_text = end_text = when
        start = datetime.fromisoformat(start_text.replace("Z", "+00:00"))
        end = datetime.fromisoformat(end_text.replace("Z", "+00:00"))
        if self.deny_history and start < NOW.replace(minute=0):
            return httpx.Response(403, json={"message": "Historic data is not part of this subscription"})
        ids = params.split(",")
        blocked = [i for i in ids if i in self.missing]
        if blocked:
            return httpx.Response(400, json={"message": f"Parameter {blocked[0]} is not available"})
        times = [start + timedelta(hours=k) for k in range(int((end - start).total_seconds() // 3600) + 1)]
        data = [
            {"parameter": pid, "coordinates": [{"lat": 24.4539, "lon": 54.3773, "dates": [
                {
                    "date": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "value": self.shape(pid, t) if self.shape else VALUES[pid] + 0.1 * k,
                }
                for k, t in enumerate(times)
            ]}]}
            for pid in ids
        ]  # fmt: skip
        return httpx.Response(200, json={
            "version": "3.0", "user": "tester", "dateGenerated": "2026-11-14T10:19:58Z",
            "status": "OK", "data": data,
        })  # fmt: skip


def client_for(fake: FakeMeteomatics) -> MeteomaticsClient:
    return MeteomaticsClient("https://api.example.test", "user", "secret", "mix", transport=httpx.MockTransport(fake))


def service_for(tmp_path, fake=None, configured=True, clock=None):
    settings = Settings(
        meteomatics_username="user" if configured else "",
        meteomatics_password="secret" if configured else "",
        meteomatics_base_url="https://api.example.test",
        data_dir=tmp_path,
    )
    store = Store(tmp_path / "state.json", Location())
    clock = clock or [NOW]
    service = WeatherService(settings, store, client_factory=lambda: client_for(fake), now=lambda: clock[0])
    return service, store, clock


# --- client -----------------------------------------------------------------------
def test_request_follows_the_documented_url_format():
    fake = FakeMeteomatics()
    start = NOW.replace(minute=0)
    series = client_for(fake).timeseries(start, start + timedelta(hours=2), ["t_2m:C", "wet_bulb_t_2m:C"], 24.4539, 54.3773)
    request = fake.requests[0]
    assert request.url.path == (
        "/2026-11-14T10:00:00Z--2026-11-14T12:00:00Z:PT1H/t_2m:C,wet_bulb_t_2m:C/24.4539,54.3773/json"
    )
    assert request.url.params["source"] == "mix"
    assert request.headers["authorization"].startswith("Basic ")
    assert series.times == [start + timedelta(hours=k) for k in range(3)]
    assert series.values["t_2m:C"] == pytest.approx([31.0, 31.1, 31.2])
    assert series.generated_at == datetime(2026, 11, 14, 10, 19, 58, tzinfo=timezone.utc)


@pytest.mark.parametrize(
    "status, kind",
    [(401, "auth"), (403, "forbidden"), (429, "rate_limited"), (503, "server"), (400, "bad_request")],
)
def test_http_failures_are_classified(status, kind):
    with pytest.raises(MeteomaticsError) as err:
        client_for(FakeMeteomatics(fail_status=status)).timeseries(NOW, NOW, ["t_2m:C"], 24.45, 54.38)
    assert err.value.kind == kind and err.value.http_status == status


def test_timeouts_network_errors_and_bad_payloads_are_classified():
    for exc, kind in [(httpx.ReadTimeout("slow"), "timeout"), (httpx.ConnectError("down"), "network")]:
        with pytest.raises(MeteomaticsError) as err:
            client_for(FakeMeteomatics(raise_exc=exc)).timeseries(NOW, NOW, ["t_2m:C"], 24.45, 54.38)
        assert err.value.kind == kind
    with pytest.raises(MeteomaticsError) as err:
        client_for(FakeMeteomatics(garbage=True)).timeseries(NOW, NOW, ["t_2m:C"], 24.45, 54.38)
    assert err.value.kind == "parse"


def test_errors_never_leak_credentials():
    with pytest.raises(MeteomaticsError) as err:
        client_for(FakeMeteomatics(fail_status=401)).timeseries(NOW, NOW, ["t_2m:C"], 24.45, 54.38)
    assert "secret" not in err.value.message and "user" not in err.value.message


def test_unavailable_parameters_are_verified_one_by_one_and_reported():
    fake = FakeMeteomatics(missing={"wet_bulb_t_2m:C", "evaporation_1h:mm"})
    ids = [p.id for p in PARAMETERS]
    series = client_for(fake).available_timeseries(NOW, NOW + timedelta(hours=3), ids, 24.45, 54.38)
    assert set(series.unavailable) == {"wet_bulb_t_2m:C", "evaporation_1h:mm"}
    assert "wet_bulb_t_2m:C" not in series.values and "t_2m:C" in series.values
    assert "not available" in series.unavailable["wet_bulb_t_2m:C"]


def test_missing_essential_parameter_is_an_error():
    fake = FakeMeteomatics(missing={"t_2m:C"})
    with pytest.raises(MeteomaticsError):
        client_for(fake).available_timeseries(NOW, NOW, [p.id for p in PARAMETERS], 24.45, 54.38)


def test_quota_is_read_from_user_stats():
    quota = client_for(FakeMeteomatics()).user_stats()
    assert (quota.used_today, quota.limit_today) == (41, 500)
    assert (quota.used_minute, quota.limit_minute) == (2, 15)
    assert quota.historic_access is True and quota.valid_until is None


def test_account_statistics_in_the_shape_the_live_api_returns():
    """The real endpoint reports history as a date range and adds the plan
    and the day the account expires."""
    fake = FakeMeteomatics(stats={
        "historic request option": "1900-01-01T00:00:00Z--2028-11-14T00:00:00Z",
        "mix type": "premium_all_1k",
        "hard deadline": "2026-11-22T00:00:00Z",
    })  # fmt: skip
    quota = client_for(fake).user_stats()
    assert quota.historic_access is True
    assert quota.historic_range == "1900-01-01T00:00:00Z--2028-11-14T00:00:00Z"
    assert quota.plan == "premium_all_1k"
    assert quota.valid_until == datetime(2026, 11, 22, tzinfo=timezone.utc)


# --- service ------------------------------------------------------------------------
def test_live_bundle_is_timestamped_and_identifies_its_source(tmp_path):
    fake = FakeMeteomatics()
    service, _, _ = service_for(tmp_path, fake)
    bundle = service.bundle()
    assert bundle.status == "live" and not bundle.synthetic and not bundle.stale
    assert bundle.provider == "Meteomatics Weather API" and bundle.model == "mix"
    assert bundle.fetched_at == NOW and bundle.last_success_at == NOW
    assert bundle.api_generated_at is not None
    assert bundle.current.time == NOW.replace(minute=0)
    assert len(bundle.hourly) == 169 and len(bundle.history) == 24
    assert bundle.wet_bulb_source == "api"
    assert all(p.source == "api" for p in bundle.parameters)
    assert bundle.quota.used_today == 41
    # Meteomatics reports evaporation as negative; the service flips the sign.
    assert bundle.current.evaporation_mm == pytest.approx(0.31)


def test_responses_are_cached_between_refreshes(tmp_path):
    fake = FakeMeteomatics()
    service, _, clock = service_for(tmp_path, fake)
    service.bundle()
    calls = len(fake.requests)
    clock[0] = NOW + timedelta(minutes=5)
    assert service.bundle().status == "live"
    assert len(fake.requests) == calls
    clock[0] = NOW + timedelta(minutes=16)
    service.bundle()
    assert len(fake.requests) > calls


def test_failure_without_cache_is_reported_not_replaced(tmp_path):
    service, _, _ = service_for(tmp_path, FakeMeteomatics(fail_status=401))
    bundle = service.bundle()
    assert bundle.status == "unavailable" and not bundle.synthetic
    assert bundle.hourly == [] and bundle.current is None
    assert bundle.error.kind == "auth"


def test_failure_after_success_serves_labelled_cached_data(tmp_path):
    fake = FakeMeteomatics()
    service, _, clock = service_for(tmp_path, fake)
    live = service.bundle()
    fake.fail_status = 503
    clock[0] = NOW + timedelta(minutes=20)
    cached = service.bundle()
    assert cached.status == "cached" and cached.stale and not cached.synthetic
    assert cached.error.kind == "server"
    assert cached.last_success_at == NOW
    assert cached.hourly[0].t_2m_c == live.hourly[0].t_2m_c
    assert "last successful" in cached.notice


def test_cache_survives_a_restart(tmp_path):
    service, _, _ = service_for(tmp_path, FakeMeteomatics())
    service.bundle()
    restarted, _, _ = service_for(tmp_path, FakeMeteomatics(fail_status=500), clock=[NOW + timedelta(hours=2)])
    bundle = restarted.bundle()
    assert bundle.status == "cached" and bundle.last_success_at == NOW
    assert bundle.current.time == (NOW + timedelta(hours=2)).replace(minute=0)


def test_wet_bulb_is_derived_and_labelled_when_the_api_lacks_it(tmp_path):
    service, _, _ = service_for(tmp_path, FakeMeteomatics(missing={"wet_bulb_t_2m:C"}))
    bundle = service.bundle()
    assert bundle.status == "live" and bundle.wet_bulb_source == "derived"
    by_id = {p.id: p for p in bundle.parameters}
    assert by_id["wet_bulb_t_2m:C"].source == "derived"
    assert bundle.current.wet_bulb_c is not None
    assert bundle.current.wet_bulb_c < bundle.current.t_2m_c


def test_history_is_optional(tmp_path):
    service, _, _ = service_for(tmp_path, FakeMeteomatics(deny_history=True))
    bundle = service.bundle()
    assert bundle.status == "live" and bundle.history == []
    assert "History not available" in bundle.notice


def test_missing_credentials_are_reported_and_default_to_demo(tmp_path):
    service, store, _ = service_for(tmp_path, FakeMeteomatics(), configured=False)
    assert service.mode() == "demo"
    store.set_weather_mode("live")
    bundle = service.bundle()
    assert bundle.status == "not_configured" and bundle.hourly == []
    assert bundle.error.kind == "not_configured"


def test_daily_quota_stops_live_requests(tmp_path):
    fake = FakeMeteomatics()
    service, _, clock = service_for(tmp_path, fake)
    service.bundle()
    service._quota.used_today = 499
    clock[0] = NOW + timedelta(minutes=9)
    data_requests = [r for r in fake.requests if r.url.path != "/user_stats_json"]
    bundle = service.bundle(force=True)
    assert bundle.status == "cached" and bundle.error.kind == "quota"
    assert len([r for r in fake.requests if r.url.path != "/user_stats_json"]) == len(data_requests)


# --- replay of past weather -----------------------------------------------------------
HEATWAVE = datetime(2026, 8, 13, 3, 40, tzinfo=timezone.utc)


def replay_for(tmp_path, fake, clock=None, at=HEATWAVE):
    service, store, clock = service_for(tmp_path, fake, clock=clock)
    store.set_weather_mode("replay")
    if at is not None:
        store.set_replay_at(at)
    return service, store, clock


def test_replay_serves_history_around_the_chosen_moment(tmp_path):
    fake = FakeMeteomatics()
    service, _, _ = replay_for(tmp_path, fake)
    bundle = service.bundle()
    at = HEATWAVE.replace(minute=0)
    assert bundle.mode == "replay" and bundle.status == "replay" and not bundle.synthetic
    assert bundle.replay_at == at and bundle.current.time == at
    assert len(bundle.history) == 24 and len(bundle.hourly) == 169
    assert bundle.history[-1].time == at - timedelta(hours=1)
    assert bundle.provider == "Meteomatics Weather API" and bundle.fetched_at == NOW
    assert "13 Aug 2026 07:00" in bundle.notice and "not a forecast" in bundle.notice
    assert "today's forecast" not in bundle.notice
    # One request covers the whole chosen day: the day before it and the week after.
    assert len(fake.data_requests) == 1
    assert fake.data_requests[0].url.path.startswith("/2026-08-12T00:00:00Z--2026-08-20T23:00:00Z:PT1H/")


def test_stepping_through_a_replayed_day_needs_no_further_requests(tmp_path):
    fake = FakeMeteomatics()
    service, store, _ = replay_for(tmp_path, fake)
    first = service.bundle()
    store.set_replay_at(HEATWAVE + timedelta(hours=12))
    later = service.bundle()
    assert later.current.time == first.current.time + timedelta(hours=12)
    assert later.current == first.hourly[12] and later.history[-1] == first.hourly[11]
    assert len(later.hourly) == 169 and len(later.history) == 24
    assert len(fake.data_requests) == 1
    store.set_replay_at(HEATWAVE + timedelta(days=1))  # the next day is a new request
    assert service.bundle().current.time == first.current.time + timedelta(days=1)
    assert len(fake.data_requests) == 2


def test_replay_is_fetched_once_and_survives_a_restart(tmp_path):
    fake = FakeMeteomatics()
    service, _, clock = replay_for(tmp_path, fake)
    first = service.bundle()
    clock[0] = NOW + timedelta(hours=3)
    assert service.bundle(force=True).current == first.current  # the past does not change
    assert len(fake.data_requests) == 1
    offline = FakeMeteomatics(fail_status=500)
    restarted, _, _ = replay_for(tmp_path, offline, clock=[NOW + timedelta(days=30)])
    bundle = restarted.bundle()
    assert bundle.status == "replay" and bundle.error is None and offline.requests == []
    assert bundle.current == first.current


def test_a_replay_that_cannot_be_retrieved_is_reported_not_replaced(tmp_path):
    service, _, _ = replay_for(tmp_path, FakeMeteomatics(fail_status=403))
    bundle = service.bundle()
    assert bundle.status == "unavailable" and not bundle.synthetic
    assert bundle.hourly == [] and bundle.current is None
    assert bundle.error.kind == "forbidden" and "No substitute data" in bundle.notice


def test_replay_needs_a_moment_and_credentials(tmp_path):
    service, _, _ = replay_for(tmp_path, FakeMeteomatics(), at=None)
    bundle = service.bundle()
    assert bundle.status == "unavailable" and bundle.error.kind == "replay"
    bare, store, _ = service_for(tmp_path / "bare", FakeMeteomatics(), configured=False)
    store.set_weather_mode("replay")
    store.set_replay_at(HEATWAVE)
    assert bare.bundle().status == "not_configured"


def test_a_recent_replay_says_where_its_last_hours_come_from(tmp_path):
    service, _, _ = replay_for(tmp_path, FakeMeteomatics(), at=NOW - timedelta(days=2))
    bundle = service.bundle()
    assert bundle.status == "replay" and bundle.hourly[-1].time > NOW
    assert "today's forecast" in bundle.notice


def test_extreme_hours_come_from_one_scan_of_the_past_year(tmp_path):
    humid = datetime(2026, 8, 13, 15, tzinfo=timezone.utc)
    hottest = datetime(2026, 8, 18, 9, tzinfo=timezone.utc)
    driest = datetime(2026, 8, 30, 9, tzinfo=timezone.utc)
    spikes = {humid: (35.0, 31.0, 75.0), hottest: (46.0, 28.0, 25.0), driest: (44.0, 22.0, 12.0)}

    def shape(pid, t):
        temp, wet_bulb, rh = spikes.get(t, (30.0, 20.0, 40.0))
        return {"t_2m:C": temp, "wet_bulb_t_2m:C": wet_bulb, "relative_humidity_2m:p": rh}[pid]

    fake = FakeMeteomatics(shape=shape)
    service, _, clock = service_for(tmp_path, fake)
    found = service.extremes()
    by_kind = {e.kind: e for e in found.extremes}
    assert [e.kind for e in found.extremes] == ["wet_bulb", "dry_bulb", "dry_air"]
    assert by_kind["wet_bulb"].time == humid and by_kind["wet_bulb"].wet_bulb_c == 31.0
    assert by_kind["dry_bulb"].time == hottest and by_kind["dry_bulb"].t_2m_c == 46.0
    assert by_kind["dry_air"].time == driest and by_kind["dry_air"].rh_pct == 12.0
    assert by_kind["wet_bulb"].replay_from == humid - timedelta(hours=12)
    assert found.hours == 365 * 24 + 1 and found.scanned_to == NOW.replace(minute=0)
    assert len(fake.data_requests) == 1
    assert fake.data_requests[0].url.path.startswith("/2025-11-14T10:00:00Z--2026-11-14T10:00:00Z:PT1H/")
    # Kept for a day, also across a restart, then scanned again.
    clock[0] = NOW + timedelta(hours=5)
    assert service.extremes() == found and len(fake.data_requests) == 1
    restarted, _, _ = service_for(tmp_path, FakeMeteomatics(fail_status=500), clock=[NOW + timedelta(hours=6)])
    assert restarted.extremes() == found
    clock[0] = NOW + timedelta(hours=25)
    service.extremes()
    assert len(fake.data_requests) == 2


def test_a_failed_rescan_keeps_the_last_list_of_extremes(tmp_path):
    fake = FakeMeteomatics()
    service, _, clock = service_for(tmp_path, fake)
    found = service.extremes()
    fake.fail_status = 503
    clock[0] = NOW + timedelta(days=3)
    assert service.extremes() == found  # still a true record of the year it names
    attempts = len(fake.requests)
    assert service.extremes() == found and len(fake.requests) == attempts  # and not retried at once
    fake.fail_status = None
    clock[0] = NOW + timedelta(days=3, minutes=10)
    assert service.extremes().scanned_to == (NOW + timedelta(days=3)).replace(minute=0)


def test_extremes_are_never_invented(tmp_path):
    bare, _, _ = service_for(tmp_path / "bare", FakeMeteomatics(), configured=False)
    with pytest.raises(MeteomaticsError) as err:
        bare.extremes()
    assert err.value.kind == "not_configured"
    denied, _, _ = service_for(tmp_path / "denied", FakeMeteomatics(fail_status=403))
    with pytest.raises(MeteomaticsError) as err:
        denied.extremes()
    assert err.value.kind == "forbidden"


# --- demo dataset ---------------------------------------------------------------------
def test_demo_mode_is_labelled_synthetic(tmp_path):
    service, store, _ = service_for(tmp_path, FakeMeteomatics())
    store.set_weather_mode("demo")
    bundle = service.bundle()
    assert bundle.status == "demo" and bundle.synthetic and bundle.mode == "demo"
    assert "synthetic" in bundle.notice.lower()
    assert all(p.source == "synthetic" for p in bundle.parameters)
    assert bundle.wet_bulb_source == "synthetic"


def test_demo_dataset_is_deterministic_and_physical():
    start = datetime(2026, 8, 3, 0, tzinfo=timezone.utc)
    a = demo.demo_series(start, 168)
    b = demo.demo_series(start, 168)
    assert a == b
    assert all(h.wet_bulb_c <= h.t_2m_c and h.dew_point_c <= h.wet_bulb_c + 1e-6 for h in a)
    assert all(3.0 <= h.rh_pct <= 100.0 and h.global_rad_w_m2 >= 0.0 for h in a)
    assert 42.0 < max(h.t_2m_c for h in a) < 48.0
    assert 29.0 < max(h.wet_bulb_c for h in a) < 33.0
    assert demo.demo_hour(start + timedelta(days=7)) .t_2m_c == a[0].t_2m_c
