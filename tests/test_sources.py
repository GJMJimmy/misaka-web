"""SOURCES manifests and the file endpoint that feeds a citation jump."""

from __future__ import annotations

from misaka_web.bridge import sources as manifests

FIXTURE = "# Sources — 庚子赈灾账册与地方财政弹性\n\nFiles gathered for this product.\n\n## Products\n\n- `synthesis.md` — 结论 (synthesis)\n\n## Cited sources (under `sources/`/)\n\n- `sources/zhenzai-v3.pdf` ← `downloads/zhenzai-v3.pdf`\n  - 卷三，赈灾账册\n  - sha256 9f2c0d1eaa\n  - cited as `doc:1a2b3c4d#p42` in conclusion\n  - cited as `doc:1a2b3c4d#p118` in plan\n- `sources/tax-records.txt` ← `downloads/tax-records.txt`\n  - sha256 77aa11\n"


def _write_manifest(board):
    folder = board["workspace"] / "nodes" / board["node"]["id"]
    (folder / "sources").mkdir(parents=True, exist_ok=True)
    (folder / "sources" / "zhenzai-v3.pdf").write_bytes(b"%PDF-1.4 fake page bytes")
    (folder / "sources" / "tax-records.txt").write_text("税关记录", encoding="utf-8")
    (folder / "SOURCES.md").write_text(FIXTURE, encoding="utf-8")
    return folder


def test_parser_reads_products_locators_and_pages():
    parsed = manifests.parse_manifest(FIXTURE)
    assert [item["kind"] for item in parsed["products"]] == ["synthesis"]
    first = parsed["sources"][0]
    assert first["placed"] == "sources/zhenzai-v3.pdf"
    assert first["original"] == "downloads/zhenzai-v3.pdf"
    assert first["sha256"] == "9f2c0d1eaa"
    assert first["locators"] == ["doc:1a2b3c4d#p42", "doc:1a2b3c4d#p118"]
    assert first["pages"] == [42, 118]
    assert parsed["sources"][1]["pages"] == []


def test_sources_endpoint_reports_existence(client, board, auth):
    _write_manifest(board)
    body = client.get(
        "/api/runs/{0}/sources".format(board["run"]["id"]),
        params={"node": board["node"]["id"]}, headers=auth,
    ).json()
    assert body["node_id"] == board["node"]["id"]
    files = {item["placed"]: item for item in body["sources"]}
    assert files["sources/zhenzai-v3.pdf"]["exists"] is True
    assert files["sources/zhenzai-v3.pdf"]["pages"] == [42, 118]
    assert files["sources/tax-records.txt"]["exists"] is True


def test_sources_endpoint_is_404_without_a_manifest(client, board, auth):
    response = client.get(
        "/api/runs/{0}/sources".format(board["run"]["id"]),
        params={"node": board["node"]["id"]}, headers=auth,
    )
    assert response.status_code == 404


def test_file_endpoint_streams_a_source(client, board, auth):
    _write_manifest(board)
    response = client.get(
        "/api/runs/{0}/file".format(board["run"]["id"]),
        params={"path": "sources/tax-records.txt", "node": board["node"]["id"]}, headers=auth,
    )
    assert response.status_code == 200
    assert "税关记录" in response.text
    assert response.headers["content-disposition"].startswith("inline")


def test_file_endpoint_supports_range_for_pdf_viewers(client, board, auth):
    _write_manifest(board)
    response = client.get(
        "/api/runs/{0}/file".format(board["run"]["id"]),
        params={"path": "sources/zhenzai-v3.pdf", "node": board["node"]["id"]},
        headers={**auth, "Range": "bytes=0-3"},
    )
    assert response.status_code == 206, response.status_code
    assert response.content == b"%PDF"


def test_file_endpoint_refuses_a_path_outside_the_workspace(client, board, auth, tmp_path):
    (tmp_path / "secret.txt").write_text("do not serve", encoding="utf-8")
    response = client.get(
        "/api/runs/{0}/file".format(board["run"]["id"]),
        params={"path": "../../../secret.txt", "node": board["node"]["id"]}, headers=auth,
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


def test_file_endpoint_is_404_for_a_missing_file(client, board, auth):
    response = client.get(
        "/api/runs/{0}/file".format(board["run"]["id"]),
        params={"path": "sources/absent.pdf", "node": board["node"]["id"]}, headers=auth,
    )
    assert response.status_code == 404

def test_run_level_sources_read_the_final_manifest(client, board, auth):
    final = board["workspace"] / "final"
    final.mkdir(parents=True, exist_ok=True)
    (final / "r_final-SOURCES.md").write_text(FIXTURE, encoding="utf-8")
    body = client.get(
        "/api/runs/{0}/sources".format(board["run"]["id"]), headers=auth,
    ).json()
    assert body["node_id"] is None
    assert body["path"].endswith("r_final-SOURCES.md")
    assert body["sources"][0]["exists"] is False, "the demo manifest names files the final folder does not hold"


def test_run_level_sources_without_a_final_manifest_is_404(client, board, auth):
    response = client.get("/api/runs/{0}/sources".format(board["run"]["id"]), headers=auth)
    assert response.status_code == 404
