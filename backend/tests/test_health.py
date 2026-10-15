from app.main import app


def test_health() -> None:
    resp = app.test_client().get("/api/v1/health")
    assert resp.status_code == 200
    assert resp.get_json() == {"status": "ok", "service": "ai-code-backend"}


def test_ping() -> None:
    resp = app.test_client().get("/api/v1/ping")
    assert resp.status_code == 200
    assert resp.get_json() == {"message": "pong"}
