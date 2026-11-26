"""The audit trail, read back."""

from __future__ import annotations

import json


def test_audit_endpoint_returns_actions_newest_first(client, board, auth):
    run_id = board["run"]["id"]
    client.post("/api/runs/{0}/stop".format(run_id), headers=auth)
    client.post("/api/runs/{0}/limits".format(run_id), json={"changes": {"sister_parallel": 2}}, headers=auth)
    body = client.get("/api/audit", headers=auth).json()
    actions = [entry["action"] for entry in body["entries"]]
    assert actions[:2] == ["limits", "stop"]
    assert body["total"] >= 2
    assert all(entry["at"] for entry in body["entries"])


def test_audit_endpoint_filters_and_limits(client, board, auth):
    run_id = board["run"]["id"]
    client.post("/api/runs/{0}/stop".format(run_id), headers=auth)
    client.post("/api/runs/{0}/limits".format(run_id), json={"changes": {"sister_parallel": 3}}, headers=auth)
    only_stop = client.get("/api/audit", params={"action": "stop"}, headers=auth).json()
    assert [entry["action"] for entry in only_stop["entries"]] == ["stop"]
    limited = client.get("/api/audit", params={"limit": 1}, headers=auth).json()
    assert len(limited["entries"]) == 1


def test_audit_endpoint_is_empty_without_a_file(client, auth):
    body = client.get("/api/audit", headers=auth).json()
    assert body["entries"] == []
    assert body["total"] == 0
