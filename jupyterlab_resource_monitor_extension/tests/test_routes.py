import json


async def test_metrics(jp_fetch):
    # When
    response = await jp_fetch("jupyterlab-resource-monitor-extension", "metrics")

    # Then
    assert response.code == 200
    payload = json.loads(response.body)
    assert set(payload) == {"mem", "cpu", "ts"}
    assert set(payload["mem"]) == {"used_bytes", "total_bytes", "limit_source"}
    assert set(payload["cpu"]) == {"percent", "cpu_count"}
